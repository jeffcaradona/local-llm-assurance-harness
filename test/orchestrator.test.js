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

test('review orchestration persists sanitized manifest and replay', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'harness-repo-'));
  const out = await mkdtemp(join(tmpdir(), 'harness-out-'));
  const admission = createAdmissionController({ maxActive: 1, maxQueued: 1 });
  const lifecycle = createLifecycleManager({ admission, shutdownGraceMs: 10, shutdownDeadlineMs: 30 });

  const collector = {
    collect: async () => [
      {
        id: 'ev-0001',
        capability: 'filesystem.readTextFile',
        sourcePath: 'src/a.js',
        lineRange: [1, 1],
        content: 'token=[REDACTED_FIELD]',
        retainedBytes: 20,
        originalBytes: 20,
        truncated: false,
        redaction: { explicitSecrets: 1 }
      }
    ]
  };

  const reviewPayload = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    summary: 'ok',
    decision: 'no_findings_in_supplied_evidence',
    observations: [],
    inferences: [],
    findings: [],
    limitations: { notes: [], omittedEvidenceIds: [] }
  };

  const provider = { complete: async () => reviewPayload };

  const orchestrator = createReviewOrchestrator({
    config: { model: { maxPromptChars: 2000 }, review: { outputDir: out } },
    collector,
    provider,
    admission,
    lifecycle
  });

  const result = await orchestrator.review({ rootPath: repo, request: 'r', includeReplay: true });
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
  await writeFile(
    bundle,
    JSON.stringify({
      runId: 'r1',
      includedEvidenceIds: ['ev-0001'],
      omittedEvidenceIds: [],
      review: {
        schemaVersion: REVIEW_SCHEMA_VERSION,
        summary: 'offline',
        decision: 'no_findings_in_supplied_evidence',
        observations: [],
        inferences: [],
        findings: [],
        limitations: { notes: [], omittedEvidenceIds: [] }
      }
    })
  );

  const output = await createReplayOrchestrator().replay({ bundlePath: bundle, format: 'terminal' });
  assert.match(output, /offline/);
});
