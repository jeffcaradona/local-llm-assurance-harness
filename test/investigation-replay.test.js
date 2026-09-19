import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  executeInvestigation,
  investigationDigest,
} from '../src/orchestrator/investigationLoop.js';
import { createReplayOrchestrator } from '../src/orchestrator/replay.js';
import { compilePromptContext } from '../src/context/compiler.js';
import { createRedactor } from '../src/redaction.js';

const config = {
  investigation: { maxModelCalls: 4, maxToolCalls: 3, timeoutMs: 60_000 },
  limits: {
    maxFiles: 10,
    maxSearchMatches: 10,
    maxFileBytes: 1024,
    maxEvidenceBytes: 4096,
  },
  model: { maxPromptChars: 80_000, maxResponseBytes: 100_000 },
};

function review(evidenceIds = []) {
  return {
    schemaVersion: '1.0.0',
    summary: 'Offline dependency investigation',
    decision: evidenceIds.length
      ? 'needs_attention'
      : 'no_findings_in_supplied_evidence',
    observations: [],
    inferences: [],
    findings: evidenceIds.length
      ? [
          {
            severity: 'medium',
            category: 'dependency',
            explanation: 'Seed imports dependency.',
            consequence: 'Dependency behavior matters.',
            recommendation: 'Check dependency.',
            evidenceIds,
          },
        ]
      : [],
    limitations: { notes: [], omittedEvidenceIds: [] },
  };
}

async function recordedRun(overrides = {}) {
  let clock = Date.UTC(2026, 0, 1);
  const calls = [];
  const result = await executeInvestigation({
    config,
    request: 'Investigate seed and dependency',
    selectedFiles: ['src/seed.js'],
    searches: [],
    trustedInstructions: [
      {
        filePath: '/nonexistent/offline-instructions.md',
        content: 'Review supplied evidence.',
      },
    ],
    now: () => clock++,
    async exchange(invocation) {
      calls.push(invocation);
      if (invocation.kind === 'model') {
        if (invocation.callId === 'model-1') {
          return {
            action: 'tool',
            tool: 'filesystem.findFiles',
            arguments: {},
          };
        }
        if (invocation.callId === 'model-2') {
          return {
            action: 'tool',
            tool: 'filesystem.readTextFile',
            arguments: { path: 'src/dependency.js' },
          };
        }
        return { action: 'final', review: review(['ev-0001', 'ev-0002']) };
      }
      if (invocation.tool === 'filesystem.findFiles') {
        return {
          status: 'success',
          paths: ['src/dependency.js', 'src/seed.js'],
        };
      }
      return {
        status: 'success',
        records: [
          {
            relativePath: invocation.arguments.path,
            lineStart: 1,
            lineEnd: 1,
            content: invocation.seed
              ? 'import "./dependency.js";'
              : 'export const dependency = true;',
          },
        ],
      };
    },
    ...overrides,
  });
  return { ...result, calls };
}

async function replay(t, bundle) {
  const directory = join(
    process.cwd(),
    `.investigation-replay-${randomUUID()}`
  );
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundlePath = join(directory, 'bundle.json');
  await writeFile(bundlePath, JSON.stringify(bundle));
  return createReplayOrchestrator().replay({ bundlePath });
}

function resign(bundle) {
  bundle.digest = investigationDigest(bundle);
  return bundle;
}

test('investigation replay reconstructs seed, discovery, dependency, citations and timing offline', async (t) => {
  const { replayBundle, calls } = await recordedRun();
  assert.equal(calls.length, 6);
  assert.deepEqual(replayBundle.includedEvidenceIds, ['ev-0001', 'ev-0002']);
  assert.ok(replayBundle.investigation.elapsedMs > 0);
  const output = await replay(t, replayBundle);
  assert.match(output, /Offline dependency investigation/);
  assert.match(output, /ev-0002/);
});

test('replay rejects tampered digest without attempting execution', async (t) => {
  const { replayBundle } = await recordedRun();
  replayBundle.review.summary = 'Changed';
  await assert.rejects(replay(t, replayBundle), { code: 'E_REPLAY_INVALID' });
});

test('replay preserves custom redaction metadata without requiring secrets', async (t) => {
  const { replayBundle } = await recordedRun({
    redactor: createRedactor({
      secrets: ['private-value'],
      patterns: [/private-value/g],
    }),
  });
  assert.equal(replayBundle.redaction.explicitSecrets, 1);
  assert.match(
    await replay(t, replayBundle),
    /Offline dependency investigation/
  );
});

test('replay permits redaction expansion beyond original byte length', async (t) => {
  const { replayBundle } = await recordedRun({
    redactor: createRedactor({ secrets: ['abc'] }),
    async exchange(invocation) {
      return invocation.kind === 'model'
        ? { action: 'final', review: review(['ev-0001']) }
        : {
            status: 'success',
            records: [
              { relativePath: 'src/seed.js', content: 'abc', originalBytes: 3 },
            ],
          };
    },
  });
  assert.equal(replayBundle.evidence[0].originalBytes, 3);
  assert.equal(replayBundle.evidence[0].content, '[REDACTED_SECRET]');
  assert.ok(replayBundle.evidence[0].retainedBytes > 3);
  assert.match(
    await replay(t, replayBundle),
    /Offline dependency investigation/
  );
});

test('replay preserves explicit absolute seeds and long operator searches', async (t) => {
  const selectedPath = join(process.cwd(), 'src', 'seed.js');
  const pattern = 'x'.repeat(1025);
  const { replayBundle } = await recordedRun({
    selectedFiles: [selectedPath],
    searches: [pattern],
    async exchange(invocation) {
      if (invocation.kind === 'model') {
        return { action: 'final', review: review(['ev-0001']) };
      }
      if (invocation.tool === 'filesystem.searchText') {
        assert.equal(invocation.arguments.pattern, pattern);
        return { status: 'success', records: [] };
      }
      assert.equal(invocation.arguments.path, selectedPath);
      return {
        status: 'success',
        records: [{ relativePath: 'src/seed.js', content: 'seed' }],
      };
    },
  });
  assert.equal(replayBundle.investigation.seedCalls, 2);
  assert.match(
    await replay(t, replayBundle),
    /Offline dependency investigation/
  );
});

test('replay reproduces bounded evidence and forced finalization', async (t) => {
  const { replayBundle } = await recordedRun({
    config: { ...config, limits: { ...config.limits, maxEvidenceBytes: 1 } },
    async exchange(invocation) {
      if (invocation.kind === 'model') {
        assert.equal(invocation.finalOnly, true);
        return { action: 'final', review: review() };
      }
      return {
        status: 'success',
        records: [{ relativePath: 'src/seed.js', content: 'too large' }],
      };
    },
  });
  assert.equal(replayBundle.evidence[0].retainedBytes, 1);
  assert.equal(replayBundle.investigation.stopReason, 'evidence_budget');
  assert.match(
    await replay(t, replayBundle),
    /Offline dependency investigation/
  );
});

test('replay reproduces context omissions', async (t) => {
  const { replayBundle } = await recordedRun({
    config: {
      ...config,
      limits: {
        ...config.limits,
        maxFileBytes: 120_000,
        maxEvidenceBytes: 200_000,
      },
    },
    async exchange(invocation) {
      return invocation.kind === 'model'
        ? { action: 'final', review: review() }
        : {
            status: 'success',
            records: [
              { relativePath: 'src/seed.js', content: 'x'.repeat(100_000) },
            ],
          };
    },
  });
  assert.deepEqual(replayBundle.omittedEvidenceIds, ['ev-0001']);
  assert.equal(replayBundle.investigation.stopReason, 'context_budget');
  assert.match(
    await replay(t, replayBundle),
    /Offline dependency investigation/
  );
});

test('replay preserves long recorded source paths without truncating their identity', async (t) => {
  const relativePath = `${'nested/'.repeat(160)}source.js`;
  const { replayBundle } = await recordedRun({
    async exchange(invocation) {
      return invocation.kind === 'model'
        ? { action: 'final', review: review(['ev-0001']) }
        : { status: 'success', records: [{ relativePath, content: 'source' }] };
    },
  });
  assert.equal(replayBundle.evidence[0].sourcePath, relativePath);
  assert.match(
    await replay(t, replayBundle),
    /Offline dependency investigation/
  );
});

test('replay reproduces tool errors and truncation of extra records', async (t) => {
  for (const outcome of [
    { status: 'error', error: { code: 'E_FILE_NOT_FOUND' } },
    {
      status: 'success',
      records: [
        { relativePath: 'src/seed.js', content: 'one' },
        { relativePath: 'src/extra.js', content: 'two' },
      ],
    },
  ]) {
    await t.test(outcome.status, async (t) => {
      const { replayBundle } = await recordedRun({
        async exchange(invocation) {
          return invocation.kind === 'model'
            ? { action: 'final', review: review() }
            : outcome;
        },
      });
      assert.match(
        await replay(t, replayBundle),
        /Offline dependency investigation/
      );
    });
  }
});

test('replay validates strict configuration, seeds, timestamps and timing', async (t) => {
  const { replayBundle } = await recordedRun();
  const cases = [
    [
      'unknown format',
      (b) => {
        b.format = 'other';
      },
    ],
    [
      'unknown version',
      (b) => {
        b.version = '2.0.0';
      },
    ],
    [
      'missing format',
      (b) => {
        delete b.format;
      },
    ],
    [
      'model budget type',
      (b) => {
        b.config.investigation.maxModelCalls = '4';
      },
    ],
    [
      'model budget ceiling',
      (b) => {
        b.config.investigation.maxModelCalls = 101;
      },
    ],
    [
      'unsafe tool budget',
      (b) => {
        b.config.investigation.maxToolCalls = Number.MAX_SAFE_INTEGER;
      },
    ],
    [
      'zero timeout',
      (b) => {
        b.config.investigation.timeoutMs = 0;
      },
    ],
    [
      'negative byte budget',
      (b) => {
        b.config.limits.maxFileBytes = -1;
      },
    ],
    [
      'unknown config property',
      (b) => {
        b.config.model.baseUrl = 'https://never-contact.invalid';
      },
    ],
    [
      'seed type',
      (b) => {
        b.selectedFiles = [false];
      },
    ],
    [
      'seed length',
      (b) => {
        b.searches = ['x'.repeat(b.config.model.maxPromptChars + 1)];
      },
    ],
    [
      'timestamp',
      (b) => {
        b.started = 8_640_000_000_000_001;
      },
    ],
    [
      'elapsed negative',
      (b) => {
        b.investigation.elapsedMs = -1;
      },
    ],
    [
      'elapsed timeout',
      (b) => {
        b.investigation.elapsedMs = 60_001;
      },
    ],
    [
      'turn timing',
      (b) => {
        b.investigation.turns[0].elapsedMs = 60_001;
      },
    ],
    [
      'turn sum timing',
      (b) => {
        for (const turn of b.investigation.turns)
          turn.elapsedMs = b.investigation.elapsedMs;
      },
    ],
    [
      'call counts',
      (b) => {
        b.investigation.toolCalls = 0;
      },
    ],
    [
      'unapproved tool',
      (b) => {
        b.events[0].tool = 'shell.execute';
      },
    ],
    [
      'tool root override',
      (b) => {
        b.events[0].arguments.root = '/';
      },
    ],
    [
      'instruction file injection',
      (b) => {
        b.instructionFiles = ['/nonexistent'];
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const bundle = JSON.parse(JSON.stringify(replayBundle));
      mutate(bundle);
      await assert.rejects(replay(t, resign(bundle)), {
        code: 'E_REPLAY_INVALID',
      });
    });
  }
});

test('replay rejects internally inconsistent execution even with a recomputed digest', async (t) => {
  const { replayBundle } = await recordedRun();
  const cases = [
    [
      'call ID',
      (b) => {
        b.events[0].callId = 'seed-99';
      },
    ],
    [
      'tool seed flag',
      (b) => {
        b.events[0].seed = false;
      },
    ],
    [
      'tool arguments',
      (b) => {
        b.events[0].arguments.path = 'other.js';
      },
    ],
    [
      'bounds',
      (b) => {
        b.events[0].bounds.maxBytes = 10;
      },
    ],
    [
      'prompt',
      (b) => {
        b.events[1].context.userPrompt = 'Invent evidence';
      },
    ],
    [
      'finalOnly',
      (b) => {
        b.events[1].finalOnly = true;
      },
    ],
    [
      'event order',
      (b) => {
        [b.events[0], b.events[1]] = [b.events[1], b.events[0]];
      },
    ],
    [
      'result envelope',
      (b) => {
        b.events[0].result.evidenceIds = [];
      },
    ],
    [
      'evidence',
      (b) => {
        b.evidence[0].content = 'Forged';
      },
    ],
    [
      'evidence timestamp',
      (b) => {
        b.evidence[0].collectedAt = '2020-01-01T00:00:00.000Z';
      },
    ],
    [
      'inclusion',
      (b) => {
        b.includedEvidenceIds = ['ev-0001'];
      },
    ],
    [
      'omission',
      (b) => {
        b.omittedEvidenceIds = ['ev-0002'];
      },
    ],
    [
      'limitations',
      (b) => {
        b.investigation.limitations = ['forged'];
      },
    ],
    [
      'stop reason',
      (b) => {
        b.investigation.stopReason = 'tool_budget';
      },
    ],
    [
      'review',
      (b) => {
        b.review.summary = 'Forged';
      },
    ],
    [
      'citation',
      (b) => {
        b.review.findings[0].evidenceIds = ['ev-9999'];
        b.events.at(-1).action.review = structuredClone(b.review);
      },
    ],
    [
      'changed valid budget',
      (b) => {
        b.config.investigation.maxModelCalls = 3;
      },
    ],
    [
      'trailing event',
      (b) => {
        b.events.push(structuredClone(b.events.at(-1)));
        b.investigation.turns.push({
          ...b.investigation.turns.at(-1),
          elapsedMs: 0,
        });
        b.investigation.modelCalls += 1;
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const bundle = JSON.parse(JSON.stringify(replayBundle));
      mutate(bundle);
      await assert.rejects(replay(t, resign(bundle)), {
        code: 'E_REPLAY_MISMATCH',
      });
    });
  }
});

test('legacy replay still reproduces review artifacts and preserves legacy errors', async (t) => {
  const request = 'Legacy offline';
  const evidence = [];
  const context = await compilePromptContext({
    request,
    evidence,
    maxChars: 10_000,
  });
  const bundle = {
    request,
    evidence,
    maxPromptChars: 10_000,
    systemPrompt: context.systemPrompt,
    userPrompt: context.userPrompt,
    includedEvidenceIds: [],
    omittedEvidenceIds: [],
    review: review(),
  };
  assert.match(await replay(t, bundle), /Offline dependency investigation/);
  await assert.rejects(replay(t, {}), { code: 'E_REPLAY_UNSUPPORTED' });
  await assert.rejects(replay(t, { ...bundle, userPrompt: 'Changed' }), {
    code: 'E_REPLAY_MISMATCH',
  });
});
