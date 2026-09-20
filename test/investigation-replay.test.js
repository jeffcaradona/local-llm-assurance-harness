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

test('replay treats expanded redacted model arguments as representations, not executable commands', async (t) => {
  const pattern = 'x'.repeat(1024);
  let modelCalls = 0;
  let toolCalls = 0;
  const { replayBundle } = await recordedRun({
    config: { ...config, model: { ...config.model, maxResponseBytes: 1500 } },
    selectedFiles: [],
    redactor: createRedactor({ secrets: ['x'] }),
    async exchange(invocation, executionArguments) {
      if (invocation.kind === 'model') {
        return modelCalls++ === 0
          ? {
              action: 'tool',
              tool: 'filesystem.searchText',
              arguments: { pattern },
            }
          : { action: 'final', review: review() };
      }
      toolCalls++;
      assert.equal(executionArguments.pattern, pattern);
      assert.equal(invocation.argumentsRedacted, true);
      assert.ok(invocation.arguments.pattern.length > 1024);
      assert.notEqual(invocation.arguments, executionArguments);
      return { status: 'success', records: [] };
    },
  });
  assert.equal(replayBundle.version, '1.1.0');
  assert.equal(replayBundle.investigation.protocolVersion, '1.0.0');
  assert.ok(replayBundle.events[0].action.arguments.pattern.length > 1500);
  assert.equal(replayBundle.events[0].responseRedacted, true);
  assert.equal(
    replayBundle.events[0].responseBytes,
    Buffer.byteLength(
      JSON.stringify({
        action: 'tool',
        tool: 'filesystem.searchText',
        arguments: { pattern },
      })
    )
  );
  assert.ok(replayBundle.events[0].responseBytes <= 1500);
  assert.match(
    await replay(t, replayBundle),
    /Offline dependency investigation/
  );
  assert.equal(modelCalls, 2);
  assert.equal(toolCalls, 1);
  for (const bytes of [0, 1, 1501, 1.5, '1100']) {
    const bundle = structuredClone(replayBundle);
    bundle.events[0].responseBytes = bytes;
    await assert.rejects(replay(t, resign(bundle)), {
      code: 'E_REPLAY_INVALID',
    });
  }
  const oversized = structuredClone(replayBundle);
  oversized.events[0].action.arguments.pattern = 'x'.repeat(80_001);
  await assert.rejects(replay(t, resign(oversized)), {
    code: 'E_REPLAY_INVALID',
  });
});

test('redacted final responses retain their original byte budget during offline replay', async (t) => {
  const rawReview = { ...review(), summary: 'z'.repeat(1000) };
  const action = { action: 'final', review: rawReview };
  const { replayBundle } = await recordedRun({
    config: { ...config, model: { ...config.model, maxResponseBytes: 1500 } },
    selectedFiles: [],
    redactor: createRedactor({ secrets: ['z'] }),
    async exchange() {
      return action;
    },
  });
  assert.equal(replayBundle.events[0].argumentsRedacted, false);
  assert.equal(replayBundle.events[0].responseRedacted, true);
  assert.equal(
    replayBundle.events[0].responseBytes,
    Buffer.byteLength(JSON.stringify(action))
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(replayBundle.events[0].action)) > 1500
  );
  assert.match(await replay(t, replayBundle), /REDACTED_SECRET/);
});

test('live redaction expansion is bounded before any tool execution', async () => {
  let toolCalls = 0;
  await assert.rejects(
    recordedRun({
      config: { ...config, model: { ...config.model, maxResponseBytes: 1500 } },
      selectedFiles: [],
      redactor: {
        redact: (value) => (value === 'x' ? 'y'.repeat(80_001) : value),
        describe: () => createRedactor().describe(),
      },
      async exchange(invocation) {
        if (invocation.kind === 'tool') toolCalls++;
        return {
          action: 'tool',
          tool: 'filesystem.searchText',
          arguments: { pattern: 'x' },
        };
      },
    }),
    { code: 'E_MODEL_RESPONSE_TOO_LARGE' }
  );
  assert.equal(toolCalls, 0);
});

test('offline replay preserves raw seed ordering and distinct seeds whose redacted paths collide', async (t) => {
  const rawPaths = [
    'z-private.js',
    'a-public.js',
    'z-other.js',
    'z-private.js',
  ];
  const executed = [];
  const { replayBundle } = await recordedRun({
    selectedFiles: rawPaths,
    searches: ['token=abc', 'token=def', 'token=abc'],
    redactor: createRedactor({ secrets: ['z-private', 'z-other'] }),
    async exchange(invocation, executionArguments) {
      if (invocation.kind === 'model')
        return { action: 'final', review: review() };
      executed.push(executionArguments);
      return { status: 'success', records: [] };
    },
  });
  assert.deepEqual(executed, [
    { path: 'a-public.js' },
    { path: 'z-other.js' },
    { path: 'z-private.js' },
    { pattern: 'token=abc' },
    { pattern: 'token=def' },
    { pattern: 'token=abc' },
  ]);
  assert.deepEqual(replayBundle.selectedFiles, [
    'a-public.js',
    '[REDACTED_SECRET].js',
    '[REDACTED_SECRET].js',
  ]);
  assert.deepEqual(
    replayBundle.searches,
    Array(3).fill('token=[REDACTED_FIELD]')
  );
  assert.deepEqual(replayBundle.seedArgumentsRedacted.selectedFiles, [
    false,
    true,
    true,
  ]);
  assert.equal(replayBundle.investigation.seedCalls, 6);
  assert.match(
    await replay(t, replayBundle),
    /Offline dependency investigation/
  );
  assert.equal(executed.length, 6);
});

test('current replay strictly validates argument-redaction metadata', async (t) => {
  const { replayBundle } = await recordedRun();
  const cases = [
    ['missing seed metadata', (b) => delete b.seedArgumentsRedacted],
    ['unknown seed metadata', (b) => (b.seedArgumentsRedacted.extra = [])],
    [
      'seed metadata count',
      (b) => (b.seedArgumentsRedacted.selectedFiles = []),
    ],
    [
      'seed metadata type',
      (b) => (b.seedArgumentsRedacted.selectedFiles[0] = 'false'),
    ],
    ['missing tool metadata', (b) => delete b.events[0].argumentsRedacted],
    ['missing model metadata', (b) => delete b.events[1].argumentsRedacted],
    ['tool metadata type', (b) => (b.events[0].argumentsRedacted = 'false')],
    ['model metadata type', (b) => (b.events[1].argumentsRedacted = null)],
    ['missing response bytes', (b) => delete b.events[1].responseBytes],
    [
      'missing response redaction flag',
      (b) => delete b.events[1].responseRedacted,
    ],
    [
      'response redaction flag type',
      (b) => (b.events[1].responseRedacted = 'false'),
    ],
    ['unredacted response bytes mismatch', (b) => b.events[1].responseBytes++],
    [
      'unredacted response bytes below minimum',
      (b) => (b.events[1].responseBytes = 1),
    ],
    [
      'unredacted response bytes beyond budget',
      (b) => (b.events[1].responseBytes = 100_001),
    ],
    [
      'inconsistent response redaction flag',
      (b) => (b.events[3].responseRedacted = true),
    ],
    [
      'redacted discovery action',
      (b) => (b.events[1].argumentsRedacted = true),
    ],
    [
      'redacted discovery operation',
      (b) => (b.events[2].argumentsRedacted = true),
    ],
    ['redacted final', (b) => (b.events.at(-1).argumentsRedacted = true)],
    ['legacy version with current metadata', (b) => (b.version = '1.0.0')],
    [
      'redacted arguments still reject extra properties',
      (b) => {
        b.events[3].argumentsRedacted = true;
        b.events[3].action.arguments.root = '/';
      },
    ],
    [
      'redacted actions still reject unapproved tools',
      (b) => {
        b.events[3].argumentsRedacted = true;
        b.events[3].action.tool = 'shell.execute';
      },
    ],
    [
      'redacted operations still reject unapproved tools',
      (b) => {
        b.events[4].argumentsRedacted = true;
        b.events[4].tool = 'shell.execute';
      },
    ],
    [
      'redacted actions still reject extra envelope fields',
      (b) => {
        b.events[3].argumentsRedacted = true;
        b.events[3].action.root = '/';
      },
    ],
    [
      'redacted operations still reject extra arguments',
      (b) => {
        b.events[4].argumentsRedacted = true;
        b.events[4].arguments.root = '/';
      },
    ],
    [
      'unredacted arguments retain original bounds',
      (b) => (b.events[3].action.arguments.path = 'x'.repeat(1025)),
    ],
    [
      'unredacted seed duplicates',
      (b) => {
        b.selectedFiles.push(b.selectedFiles[0]);
        b.seedArgumentsRedacted.selectedFiles.push(false);
      },
    ],
    [
      'unredacted seed order',
      (b) => {
        b.selectedFiles.push('a.js');
        b.seedArgumentsRedacted.selectedFiles.push(false);
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const bundle = structuredClone(replayBundle);
      mutate(bundle);
      await assert.rejects(replay(t, resign(bundle)), {
        code: 'E_REPLAY_INVALID',
      });
    });
  }
});

test('replay rejects inconsistent seed, action and operation redaction flags', async (t) => {
  const { replayBundle } = await recordedRun();
  for (const mutate of [
    (b) => (b.seedArgumentsRedacted.selectedFiles[0] = true),
    (b) => (b.events[0].argumentsRedacted = true),
    (b) => {
      b.events[3].argumentsRedacted = true;
      b.events[3].responseRedacted = true;
    },
    (b) => (b.events[4].argumentsRedacted = true),
  ]) {
    const bundle = structuredClone(replayBundle);
    mutate(bundle);
    await assert.rejects(replay(t, resign(bundle)), {
      code: 'E_REPLAY_MISMATCH',
    });
  }
});

test('investigation v1 reconstruction remains compatible and rejects current metadata', async (t) => {
  // Explicit reconstruction mode generates the legacy fixture without exposing
  // legacy recording as an option on the live runInvestigation entry point.
  const { replayBundle } = await recordedRun({
    replayRecord: { version: '1.0.0', events: [] },
  });
  assert.equal(replayBundle.version, '1.0.0');
  assert.equal(replayBundle.seedArgumentsRedacted, undefined);
  assert.ok(
    replayBundle.events.every((event) => !('argumentsRedacted' in event))
  );
  assert.match(
    await replay(t, replayBundle),
    /Offline dependency investigation/
  );
  const current = await recordedRun();
  assert.deepEqual(
    replayBundle.events
      .filter((event) => event.kind === 'model')
      .map((event) => event.context),
    current.replayBundle.events
      .filter((event) => event.kind === 'model')
      .map((event) => event.context)
  );
  for (const selectedFiles of [
    ['src/seed.js', 'src/seed.js'],
    ['src/seed.js', 'a.js'],
  ]) {
    const malformed = structuredClone(replayBundle);
    malformed.selectedFiles = selectedFiles;
    await assert.rejects(replay(t, resign(malformed)), {
      code: 'E_REPLAY_INVALID',
    });
  }
  replayBundle.events[0].argumentsRedacted = false;
  await assert.rejects(replay(t, resign(replayBundle)), {
    code: 'E_REPLAY_INVALID',
  });
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

test('replay preserves search accounting when a context omission prunes remaining matches', async (t) => {
  const { replayBundle } = await recordedRun({
    selectedFiles: [],
    searches: ['needle'],
    config: {
      ...config,
      limits: {
        ...config.limits,
        maxSearchMatches: 2,
        maxFileBytes: 120_000,
        maxEvidenceBytes: 300_000,
      },
    },
    async exchange(invocation) {
      return invocation.kind === 'model'
        ? { action: 'final', review: review() }
        : {
            status: 'success',
            records: [
              { relativePath: 'a.js', content: 'x'.repeat(100_000) },
              { relativePath: 'b.js', content: 'x'.repeat(100_000) },
            ],
          };
    },
  });
  assert.equal(replayBundle.events[0].outcome.recordCount, 2);
  assert.equal(replayBundle.events[0].outcome.records.length, 1);
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

test('replay rejects invalid considered record accounting', async (t) => {
  const { replayBundle } = await recordedRun();
  const cases = [
    [
      'missing count',
      (b) => {
        delete b.events[0].outcome.consideredRecords;
      },
    ],
    [
      'noninteger count',
      (b) => {
        b.events[0].outcome.consideredRecords = 0.5;
      },
    ],
    [
      'below retained count',
      (b) => {
        b.events[0].outcome.consideredRecords = 0;
      },
    ],
    [
      'above returned count',
      (b) => {
        b.events[0].outcome.consideredRecords = 2;
      },
    ],
    [
      'read bound',
      (b) => {
        b.events[0].outcome.recordCount = 2;
        b.events[0].outcome.consideredRecords = 2;
      },
    ],
    [
      'discovery count',
      (b) => {
        b.events[2].outcome.recordCount = 1;
        b.events[2].outcome.consideredRecords = 1;
      },
    ],
    [
      'error count',
      (b) => {
        Object.assign(b.events[0].outcome, {
          status: 'error',
          records: [],
          consideredRecords: 1,
          error: { code: 'E_FILE_NOT_FOUND', message: 'Unavailable' },
        });
      },
    ],
    [
      'search bound',
      (b) => {
        Object.assign(b.events[0], {
          tool: 'filesystem.searchText',
          arguments: { pattern: 'needle' },
        });
        b.events[0].outcome.recordCount = 11;
        b.events[0].outcome.consideredRecords = 11;
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
        b.events.at(-1).responseBytes = Buffer.byteLength(
          JSON.stringify(b.events.at(-1).action)
        );
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
