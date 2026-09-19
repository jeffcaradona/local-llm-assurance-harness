import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewOrchestrator } from '../src/orchestrator/reviewOrchestrator.js';
import { createAdmissionController } from '../src/admission/controller.js';
import { createLifecycleManager } from '../src/lifecycle/manager.js';
import { REVIEW_SCHEMA_VERSION } from '../src/review/schema.js';
import { createReplayOrchestrator } from '../src/orchestrator/replay.js';
import { HarnessError } from '../src/errors.js';
import { compilePromptContext } from '../src/context/compiler.js';

test('review orchestration persists sanitized manifest and replay', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'harness-repo-'));
  const out = await mkdtemp(join(tmpdir(), 'harness-out-'));
  const admission = createAdmissionController({ maxActive: 1, maxQueued: 1 });
  const lifecycle = createLifecycleManager({
    admission,
    shutdownGraceMs: 10,
    shutdownDeadlineMs: 30,
  });

  const collectorRecord = {
    relativePath: 'src/a.js',
    lineStart: 1,
    lineEnd: 1,
    content: 'token=[REDACTED_FIELD]',
    retainedBytes: 20,
    originalBytes: 20,
    truncated: false,
    redaction: { explicitSecrets: 1 },
  };

  const capabilities = {
    get(name) {
      if (name === 'filesystem.findFiles')
        return { invoke: async () => ['src/a.js'] };
      if (name === 'filesystem.readTextFile')
        return { invoke: async () => collectorRecord };
      if (name === 'filesystem.searchText') return { invoke: async () => [] };
      throw new Error(`Unknown capability: ${name}`);
    },
  };

  const reviewPayload = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    summary: 'ok',
    decision: 'no_findings_in_supplied_evidence',
    observations: [],
    inferences: [],
    findings: [],
    limitations: { notes: [], omittedEvidenceIds: [] },
  };

  const provider = { complete: async () => reviewPayload };

  const orchestrator = createReviewOrchestrator({
    config: {
      model: { maxPromptChars: 10_000 },
      review: { outputDir: out },
      limits: {
        maxFiles: 10,
        maxEvidenceBytes: 1000,
        maxFileBytes: 1000,
        maxSearchMatches: 10,
      },
    },
    capabilities,
    provider,
    admission,
    lifecycle,
  });

  const result = await orchestrator.review({
    rootPath: repo,
    request: 'r',
    includeReplay: true,
  });
  assert.match(result.reportText, /Decision:/);

  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'success');
  assert.equal(manifest.evidenceSummary[0].sourcePath, 'src/a.js');
  assert.equal(manifest.evidenceSummary[0].content, undefined);

  const replay = JSON.parse(await readFile(result.replayPath, 'utf8'));
  assert.equal(replay.review.summary, 'ok');
});

test('replay validates without external dependencies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-replay-'));
  const bundle = join(dir, 'bundle.json');
  const evidence = [
    {
      id: 'ev-0001',
      sourcePath: 'src/a.js',
      lineRange: [1, 1],
      content: 'const a = 1;',
    },
  ];
  const context = await compilePromptContext({
    request: 'Offline review',
    evidence,
    instructionFiles: [],
    maxChars: 10_000,
  });
  await writeFile(
    bundle,
    JSON.stringify({
      runId: 'r1',
      request: 'Offline review',
      evidence,
      maxPromptChars: 10_000,
      systemPrompt: context.systemPrompt,
      userPrompt: context.userPrompt,
      includedEvidenceIds: ['ev-0001'],
      omittedEvidenceIds: [],
      review: {
        schemaVersion: REVIEW_SCHEMA_VERSION,
        summary: 'offline',
        decision: 'no_findings_in_supplied_evidence',
        observations: [],
        inferences: [],
        findings: [],
        limitations: { notes: [], omittedEvidenceIds: [] },
      },
    })
  );

  const output = await createReplayOrchestrator().replay({
    bundlePath: bundle,
    format: 'terminal',
  });
  assert.match(output, /offline/);
});

test('auto discovery skips blocked files but explicit file selection fails', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'harness-repo-'));
  const out = await mkdtemp(join(tmpdir(), 'harness-out-'));
  const admission = createAdmissionController({ maxActive: 1, maxQueued: 1 });
  const lifecycle = createLifecycleManager({
    admission,
    shutdownGraceMs: 10,
    shutdownDeadlineMs: 30,
  });

  const capabilities = {
    get(name) {
      if (name === 'filesystem.findFiles')
        return { invoke: async () => ['.env', 'src/a.js'] };
      if (name === 'filesystem.readTextFile') {
        return {
          invoke: async ({ path }) => {
            if (path === '.env') {
              throw new HarnessError('E_SENSITIVE_PATH_BLOCKED', 'blocked');
            }
            return {
              relativePath: path,
              lineStart: 1,
              lineEnd: 1,
              content: 'const a = 1;',
              retainedBytes: 12,
              originalBytes: 12,
              truncated: false,
              redaction: {},
            };
          },
        };
      }
      if (name === 'filesystem.searchText') return { invoke: async () => [] };
      throw new Error(`Unknown capability: ${name}`);
    },
  };

  const reviewPayload = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    summary: 'ok',
    decision: 'no_findings_in_supplied_evidence',
    observations: [],
    inferences: [],
    findings: [],
    limitations: { notes: [], omittedEvidenceIds: [] },
  };

  const orchestrator = createReviewOrchestrator({
    config: {
      model: { maxPromptChars: 10_000 },
      review: { outputDir: out },
      limits: {
        maxFiles: 10,
        maxEvidenceBytes: 1000,
        maxFileBytes: 1000,
        maxSearchMatches: 10,
      },
    },
    capabilities,
    provider: { complete: async () => reviewPayload },
    admission,
    lifecycle,
  });

  const autoResult = await orchestrator.review({
    rootPath: repo,
    request: 'r',
  });
  assert.match(autoResult.reportText, /Decision:/);

  await assert.rejects(
    () =>
      orchestrator.review({
        rootPath: repo,
        request: 'r',
        selectedFiles: ['.env'],
      }),
    { code: 'E_SENSITIVE_PATH_BLOCKED' }
  );
});
