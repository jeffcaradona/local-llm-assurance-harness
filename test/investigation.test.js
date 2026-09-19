import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveRuntimeConfig, validateRuntimeConfig } from '../src/config.js';
import { HarnessError } from '../src/errors.js';
import { createRedactor } from '../src/redaction.js';
import { createAdmissionController } from '../src/admission/controller.js';
import { createLifecycleManager } from '../src/lifecycle/manager.js';
import { REVIEW_SCHEMA_VERSION } from '../src/review/schema.js';
import { runInvestigation } from '../src/orchestrator/investigationLoop.js';
import { compileInvestigationContext } from '../src/orchestrator/investigationContext.js';
import { createReviewOrchestrator } from '../src/orchestrator/reviewOrchestrator.js';

function config(overrides = {}) {
  const defaults = resolveRuntimeConfig({});
  return {
    ...defaults,
    ...overrides,
    model: { ...defaults.model, ...overrides.model },
    limits: { ...defaults.limits, ...overrides.limits },
    investigation: { ...defaults.investigation, ...overrides.investigation },
  };
}

function final(evidenceIds = [], overrides = {}) {
  return {
    action: 'final',
    review: {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      summary: 'Reviewed supplied evidence.',
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
              explanation: 'The caller and dependency disagree.',
              consequence: 'The operation can fail.',
              recommendation: 'Align the caller and dependency.',
              evidenceIds,
            },
          ]
        : [],
      limitations: { notes: [], omittedEvidenceIds: [] },
      ...overrides,
    },
  };
}

function tool(name, args = {}) {
  return { action: 'tool', tool: `filesystem.${name}`, arguments: args };
}

function record(path, content = 'export const value = 1;', overrides = {}) {
  return {
    relativePath: path,
    lineStart: 1,
    lineEnd: 1,
    content,
    retainedBytes: Buffer.byteLength(content),
    originalBytes: Buffer.byteLength(content),
    truncated: false,
    redaction: {},
    ...overrides,
  };
}

function scripted(actions, handlers = {}) {
  const calls = [];
  const prompts = [];
  const provider = {
    async complete(input) {
      const index = prompts.push(input) - 1;
      assert.ok(index < actions.length, 'unexpected model call');
      const action = actions[index];
      return typeof action === 'function' ? action(input) : action;
    },
  };
  const capabilities = {
    get(name) {
      assert.ok(
        [
          'filesystem.findFiles',
          'filesystem.searchText',
          'filesystem.readTextFile',
        ].includes(name),
        'unexpected capability lookup'
      );
      return {
        async invoke(args) {
          calls.push({ name, args });
          const handler = handlers[name];
          if (handler) return handler(args);
          if (name === 'filesystem.findFiles') return ['src/a.js'];
          if (name === 'filesystem.searchText') return [];
          return record(args.path);
        },
      };
    },
  };
  return { provider, capabilities, calls, prompts };
}

function run(io, options = {}) {
  return runInvestigation({
    config: config(),
    request: 'Investigate the dependency.',
    ...io,
    ...options,
  });
}

function body(prompt) {
  return JSON.parse(prompt.userPrompt);
}

async function workspace(t) {
  const base = resolve(`.investigation-test-${randomUUID()}`);
  t.after(() => rm(base, { recursive: true, force: true }));
  const rootPath = join(base, 'repo');
  const outputDir = join(base, 'artifacts');
  await mkdir(rootPath, { recursive: true });
  return { rootPath, outputDir };
}

function orchestrator(io, outputDir, overrides = {}) {
  const admission = createAdmissionController({ maxActive: 1, maxQueued: 1 });
  const lifecycle = createLifecycleManager({
    admission,
    shutdownGraceMs: 10,
    shutdownDeadlineMs: 30,
  });
  return {
    admission,
    reviewer: createReviewOrchestrator({
      config: config({ ...overrides, review: { outputDir } }),
      ...io,
      admission,
      lifecycle,
    }),
  };
}

test('investigation defaults retain the ordinary prompt and collection budgets', () => {
  const value = validateRuntimeConfig(config());
  assert.equal(value.model.maxPromptChars, 80_000);
  assert.equal(value.model.maxResponseBytes, 512 * 1024);
  assert.equal(value.limits.maxFileBytes, 48 * 1024);
  assert.equal(value.limits.maxEvidenceBytes, 400 * 1024);
  assert.equal(value.limits.maxFiles, 40);
  assert.equal(value.limits.maxSearchMatches, 200);
  assert.deepEqual(value.investigation, {
    maxModelCalls: 8,
    maxToolCalls: 6,
    timeoutMs: 600_000,
  });
});

test('a seedless investigation starts with the model and accepts the first final', async () => {
  const io = scripted([final()]);
  const result = await run(io);
  assert.deepEqual(io.calls, []);
  assert.deepEqual(body(io.prompts[0]).evidence, []);
  assert.deepEqual(body(io.prompts[0]).navigation, []);
  assert.equal(result.investigation.modelCalls, 1);
  assert.equal(result.investigation.toolCalls, 0);
  assert.equal(result.investigation.seedCalls, 0);
  assert.equal(result.investigation.budgetForced, false);
  assert.equal(result.investigation.stopReason, 'final');
});

test('seed and search evidence guide a dependency read and final cites both files', async () => {
  const io = scripted(
    [
      tool('readTextFile', { path: 'src/dependency.js' }),
      final(['ev-0001', 'ev-0003']),
    ],
    {
      'filesystem.readTextFile': ({ path }) =>
        record(
          path,
          path === 'src/caller.js'
            ? 'dependency(value);'
            : 'export function dependency() {}'
        ),
      'filesystem.searchText': () => [
        record('src/dependency.js', 'export function dependency() {}', {
          lineStart: 7,
          lineEnd: 7,
        }),
      ],
    }
  );
  const result = await run(io, {
    selectedFiles: ['src/caller.js', 'src/caller.js'],
    searches: ['dependency'],
  });
  assert.deepEqual(
    io.calls.map(({ name }) => name),
    [
      'filesystem.readTextFile',
      'filesystem.searchText',
      'filesystem.readTextFile',
    ]
  );
  assert.deepEqual(
    body(io.prompts[0]).evidence.map(({ id }) => id),
    ['ev-0001', 'ev-0002']
  );
  assert.deepEqual(
    body(io.prompts[1]).evidence.map(({ id }) => id),
    ['ev-0001', 'ev-0002', 'ev-0003']
  );
  assert.deepEqual(body(io.prompts[1]).navigation.at(-1).evidenceIds, [
    'ev-0003',
  ]);
  assert.deepEqual(result.review.findings[0].evidenceIds, [
    'ev-0001',
    'ev-0003',
  ]);
  assert.equal(result.investigation.seedCalls, 2);
  assert.equal(result.investigation.toolCalls, 1);
});

test('discovery is navigation only and its result appears in the next model call', async () => {
  const io = scripted([tool('findFiles'), final()], {
    'filesystem.findFiles': () => ['z.js', 'a.js', 'a.js'],
  });
  const result = await run(io);
  assert.deepEqual(body(io.prompts[1]).navigation[0].paths, ['a.js', 'z.js']);
  assert.deepEqual(body(io.prompts[1]).evidence, []);
  assert.deepEqual(result.evidence, []);
  assert.equal(io.calls.length, 1);
});

for (const [label, action] of [
  [
    'unknown tool',
    { action: 'tool', tool: 'shell.exec', arguments: { command: 'id' } },
  ],
  ['wrong argument type', tool('readTextFile', { path: 7 })],
  ['extra argument', tool('searchText', { pattern: 'x', root: '/' })],
  ['extra discovery argument', tool('findFiles', { limit: 99 })],
  ['extra envelope field', { ...tool('findFiles'), command: 'id' }],
  ['missing argument', tool('readTextFile')],
  ['wrong action', { action: 'delegate', arguments: {} }],
  ['invalid final', { action: 'final', review: { summary: 'incomplete' } }],
]) {
  test(`invalid investigation action rejects ${label} before capability execution`, async () => {
    const io = scripted([action]);
    await assert.rejects(run(io), { code: 'E_INVESTIGATION_ACTION_INVALID' });
    assert.equal(io.prompts.length, 1);
    assert.deepEqual(io.calls, []);
  });
}

test('missing files produce a safe bounded result and investigation can continue', async () => {
  const privateMessage = 'private-machine-path-and-credential';
  const io = scripted([tool('readTextFile', { path: 'missing.js' }), final()], {
    'filesystem.readTextFile': () => {
      throw new HarnessError('E_FILE_NOT_FOUND', privateMessage, {
        path: privateMessage,
      });
    },
  });
  const result = await run(io);
  const outcome = body(io.prompts[1]).navigation[0];
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.error.code, 'E_FILE_NOT_FOUND');
  assert.equal(
    outcome.error.message,
    'Approved filesystem operation could not be completed.'
  );
  assert.ok(!JSON.stringify(result).includes(privateMessage));
  assert.deepEqual(result.evidence, []);
});

test('unexpected capability failures terminate with a sanitized error', async () => {
  const io = scripted([tool('readTextFile', { path: 'a.js' })], {
    'filesystem.readTextFile': () => {
      throw new Error('private failure details');
    },
  });
  await assert.rejects(run(io), (error) => {
    assert.equal(error.code, 'E_INTERNAL');
    assert.ok(!JSON.stringify(error).includes('private failure details'));
    return true;
  });
  assert.equal(io.prompts.length, 1);
});

test('redaction covers arguments, evidence, review, prompts and persisted replay', async (t) => {
  const { rootPath, outputDir } = await workspace(t);
  const secret = 'fixture-sensitive-value';
  const redactor = createRedactor({ secrets: [secret] });
  const io = scripted(
    [
      tool('searchText', { pattern: secret }),
      final(['ev-0001'], { summary: `Review ${secret}` }),
    ],
    {
      'filesystem.searchText': () => [
        record(`src/${secret}.js`, `data ${secret}`),
      ],
    }
  );
  const { reviewer, admission } = orchestrator({ ...io, redactor }, outputDir);
  const result = await reviewer.review({
    rootPath,
    request: `Review ${secret}`,
    investigate: true,
    includeReplay: true,
    format: 'json',
  });
  assert.equal(io.calls[0].args.pattern, '[REDACTED_SECRET]');
  const manifestText = await readFile(result.manifestPath, 'utf8');
  const replayText = await readFile(result.replayPath, 'utf8');
  for (const text of [
    result.reportText,
    manifestText,
    replayText,
    JSON.stringify(io.prompts),
  ]) {
    assert.ok(!text.includes(secret));
  }
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.request, undefined);
  assert.equal(manifest.review, undefined);
  assert.equal(manifest.evidenceSummary[0].content, undefined);
  const replay = JSON.parse(replayText);
  assert.equal(replay.config.model.apiKey, undefined);
  assert.equal(replay.events[0].action.arguments.pattern, '[REDACTED_SECRET]');
  assert.equal(replay.review.summary, 'Review [REDACTED_SECRET]');
  assert.equal(admission.stats().active, 0);
});

test('JSON reports and metadata-only default manifests include investigation accounting', async (t) => {
  const { rootPath, outputDir } = await workspace(t);
  const io = scripted([
    tool('readTextFile', { path: 'a.js' }),
    final(['ev-0001']),
  ]);
  const { reviewer } = orchestrator(io, outputDir);
  const result = await reviewer.review({
    rootPath,
    request: 'review',
    investigate: true,
    format: 'json',
  });
  const report = JSON.parse(result.reportText);
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(report.investigation.mode, 'investigation');
  assert.equal(report.investigation.protocolVersion, '1.0.0');
  assert.equal(report.investigation.modelCalls, 2);
  assert.equal(report.investigation.toolCalls, 1);
  assert.equal(report.investigation.seedCalls, 0);
  assert.ok(report.investigation.elapsedMs >= 0);
  assert.equal(report.investigation.turns.length, 3);
  assert.deepEqual(report.includedEvidenceIds, ['ev-0001']);
  assert.deepEqual(manifest.investigation, report.investigation);
  assert.equal(manifest.evidenceSummary[0].content, undefined);
  assert.equal(manifest.request, undefined);
  assert.equal(result.replayPath, undefined);
  assert.equal((await readdir(outputDir)).length, 1);
});

for (const [label, budget, actions, reason, count] of [
  [
    'tool cap',
    { maxToolCalls: 2 },
    [
      tool('searchText', { pattern: 'x' }),
      tool('searchText', { pattern: 'x' }),
      final(),
    ],
    'tool_budget',
    2,
  ],
  [
    'model cap',
    { maxModelCalls: 2 },
    [tool('searchText', { pattern: 'x' }), final()],
    'model_budget',
    1,
  ],
  ['zero tool cap', { maxToolCalls: 0 }, [final()], 'tool_budget', 0],
  ['one model call', { maxModelCalls: 1 }, [final()], 'model_budget', 0],
]) {
  test(`${label} reserves a final-only turn without exceeding call budgets`, async () => {
    const io = scripted(actions);
    const result = await run(io, { config: config({ investigation: budget }) });
    assert.equal(io.calls.length, count);
    assert.equal(result.investigation.stopReason, reason);
    assert.equal(result.investigation.budgetForced, true);
    assert.match(io.prompts.at(-1).systemPrompt, /FINAL ONLY/);
    assert.equal(
      io.prompts.at(-1).responseSchema.properties.action.const,
      'final'
    );
  });
}

test('a tool action on the final-only turn is rejected without another execution', async () => {
  const io = scripted([tool('findFiles'), tool('findFiles')]);
  await assert.rejects(
    run(io, { config: config({ investigation: { maxToolCalls: 1 } }) }),
    {
      code: 'E_INVESTIGATION_FINAL_ONLY',
    }
  );
  assert.equal(io.calls.length, 1);
  assert.equal(io.prompts.length, 2);
});

test('repeated identical reads reuse evidence identity and changed content creates a new ID', async () => {
  let reads = 0;
  const io = scripted(
    [
      tool('readTextFile', { path: 'a.js' }),
      tool('readTextFile', { path: 'a.js' }),
      tool('readTextFile', { path: 'a.js' }),
      final(['ev-0001', 'ev-0002']),
    ],
    {
      'filesystem.readTextFile': ({ path }) =>
        record(path, ++reads < 3 ? 'old' : 'new'),
    }
  );
  const result = await run(io, {
    config: config({ limits: { maxEvidenceBytes: 7 } }),
  });
  assert.deepEqual(
    result.evidence.map(({ id, content }) => [id, content]),
    [
      ['ev-0001', 'old'],
      ['ev-0002', 'new'],
    ]
  );
  assert.deepEqual(body(io.prompts[2]).navigation[1].evidenceIds, ['ev-0001']);
  assert.equal(result.investigation.stopReason, 'final');
  assert.equal(result.investigation.toolCalls, 3);
});

test('aggregate evidence bytes truncate the last record and stop further gathering', async () => {
  const io = scripted([final(['ev-0001'])], {
    'filesystem.readTextFile': ({ path }) => record(path, '1234'),
  });
  const result = await run(io, {
    selectedFiles: ['c.js', 'a.js', 'b.js'],
    config: config({ limits: { maxEvidenceBytes: 7 } }),
  });
  assert.deepEqual(
    io.calls.map(({ args }) => args.path),
    ['a.js', 'b.js']
  );
  assert.deepEqual(result.context.includedEvidenceIds, ['ev-0001', 'ev-0002']);
  assert.deepEqual(result.context.omittedEvidenceIds, []);
  assert.equal(
    result.evidence.reduce((sum, item) => sum + item.retainedBytes, 0),
    7
  );
  assert.equal(result.evidence[1].content, '123');
  assert.equal(result.evidence[1].truncated, true);
  assert.equal(result.investigation.stopReason, 'evidence_budget');
  assert.equal(result.investigation.budgetForced, true);
  assert.deepEqual(
    body(io.prompts[0]).evidence.map(({ sourcePath }) => sourcePath),
    ['a.js', 'b.js']
  );
});

test('context budget includes transport schema and forces final before overflowing', async () => {
  const io = scripted([final()], {
    'filesystem.readTextFile': ({ path }) => record(path, 'x'.repeat(30_000)),
  });
  const result = await run(io, {
    selectedFiles: ['a.js'],
    config: config({ model: { maxPromptChars: 20_000 } }),
  });
  assert.equal(result.investigation.stopReason, 'context_budget');
  assert.deepEqual(result.context.includedEvidenceIds, []);
  assert.deepEqual(result.context.omittedEvidenceIds, ['ev-0001']);
  for (const prompt of io.prompts) {
    assert.ok(
      prompt.systemPrompt.length +
        prompt.userPrompt.length +
        JSON.stringify(prompt.responseSchema).length <=
        20_000
    );
  }
  const context = compileInvestigationContext({
    request: 'r',
    trustedInstructions: [],
    evidence: [],
    summaries: [],
    limitations: [],
    finalOnly: false,
    maxChars: 80_000,
  });
  assert.equal(
    context.usedChars,
    context.systemPrompt.length +
      context.userPrompt.length +
      JSON.stringify(context.responseSchema).length
  );
});

test('an impossibly small prompt budget fails before model or filesystem work', async () => {
  const io = scripted([final()]);
  await assert.rejects(
    run(io, {
      selectedFiles: ['a.js'],
      config: config({ model: { maxPromptChars: 100 } }),
    }),
    { code: 'E_PROMPT_BUDGET_EXCEEDED' }
  );
  assert.deepEqual(io.calls, []);
  assert.deepEqual(io.prompts, []);
});

test('per-file byte truncation is UTF-8 bounded and recorded as a limitation', async () => {
  const io = scripted([final(['ev-0001'])], {
    'filesystem.readTextFile': ({ path }) => record(path, 'é'.repeat(10)),
  });
  const result = await run(io, {
    selectedFiles: ['a.js'],
    config: config({ limits: { maxFileBytes: 5 } }),
  });
  assert.ok(result.evidence[0].retainedBytes <= 5);
  assert.equal(result.evidence[0].truncated, true);
  assert.ok(result.investigation.limitations.includes('truncated_evidence'));
});

test('search match and discovery bounds are aggregate, not reset per tool', async () => {
  const io = scripted(
    [
      tool('searchText', { pattern: 'one' }),
      tool('searchText', { pattern: 'two' }),
      final(),
    ],
    {
      'filesystem.searchText': ({ pattern }) => [
        record(`${pattern}.js`, pattern),
      ],
    }
  );
  const result = await run(io, {
    config: config({ limits: { maxSearchMatches: 2 } }),
  });
  assert.deepEqual(
    io.calls.map(({ args }) => args.maxMatches),
    [2, 1]
  );
  assert.equal(result.investigation.stopReason, 'collection_budget');
  assert.match(io.prompts.at(-1).systemPrompt, /FINAL ONLY/);

  const discovery = scripted([tool('findFiles'), tool('findFiles'), final()], {
    'filesystem.findFiles': () => ['a.js'],
  });
  await run(discovery, { config: config({ limits: { maxFiles: 2 } }) });
  assert.deepEqual(
    discovery.calls.map(({ args }) => args.limit),
    [2, 1]
  );
  assert.deepEqual(body(discovery.prompts.at(-1)).evidence, []);
});

for (const [label, action, options] of [
  ['unknown finding', final(['ev-9999']), {}],
  ['discovery path', final(['src/a.js']), {}],
  [
    'omitted finding',
    final(['ev-0001']),
    {
      selectedFiles: ['a.js'],
      config: config({ model: { maxPromptChars: 20_000 } }),
    },
  ],
  [
    'invented omission',
    final([], { limitations: { notes: [], omittedEvidenceIds: ['ev-9999'] } }),
    {},
  ],
  [
    'included ID claimed omitted',
    final([], { limitations: { notes: [], omittedEvidenceIds: ['ev-0001'] } }),
    { selectedFiles: ['a.js'] },
  ],
]) {
  test(`final reference validation rejects ${label}`, async () => {
    const handlers =
      label === 'omitted finding'
        ? {
            'filesystem.readTextFile': ({ path }) =>
              record(path, 'x'.repeat(30_000)),
          }
        : {};
    await assert.rejects(run(scripted([action], handlers), options), {
      code: 'E_UNKNOWN_EVIDENCE_REFERENCE',
    });
  });
}

test('valid omitted IDs are accepted only as limitations, not finding evidence', async () => {
  const result = await run(
    scripted(
      [
        final([], {
          limitations: {
            notes: ['Insufficient evidence budget.'],
            omittedEvidenceIds: ['ev-0001'],
          },
        }),
      ],
      {
        'filesystem.readTextFile': ({ path }) =>
          record(path, 'x'.repeat(30_000)),
      }
    ),
    {
      selectedFiles: ['a.js'],
      config: config({ model: { maxPromptChars: 20_000 } }),
    }
  );
  assert.deepEqual(result.review.limitations.omittedEvidenceIds, ['ev-0001']);
});

test('cancellation before investigation prevents all calls', async () => {
  const controller = new AbortController();
  controller.abort();
  const io = scripted([final()]);
  await assert.rejects(run(io, { signal: controller.signal }), {
    code: 'E_ABORTED',
  });
  assert.deepEqual(io.calls, []);
  assert.deepEqual(io.prompts, []);
});

for (const phase of ['model', 'tool']) {
  test(`cancellation during an uncooperative ${phase} settles and aborts its signal`, async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers();
    let receivedSignal;
    const wait = ({ signal }) => {
      receivedSignal = signal;
      entered.resolve();
      return new Promise(() => {});
    };
    const io = scripted(
      phase === 'model' ? [wait] : [tool('readTextFile', { path: 'a.js' })],
      phase === 'tool' ? { 'filesystem.readTextFile': wait } : {}
    );
    const pending = run(io, { signal: controller.signal });
    const rejected = assert.rejects(pending, { code: 'E_ABORTED' });
    await entered.promise;
    controller.abort();
    await rejected;
    assert.equal(receivedSignal.aborted, true);
    assert.equal(io.prompts.length, 1);
    assert.equal(io.calls.length, phase === 'tool' ? 1 : 0);
  });
}

test('cancellation after a model result prevents the requested tool', async () => {
  const controller = new AbortController();
  const io = scripted([
    () => {
      controller.abort();
      return tool('readTextFile', { path: 'a.js' });
    },
  ]);
  await assert.rejects(run(io, { signal: controller.signal }), {
    code: 'E_ABORTED',
  });
  assert.deepEqual(io.calls, []);
});

test('cancellation after a tool result prevents the following model call', async () => {
  const controller = new AbortController();
  const io = scripted([tool('readTextFile', { path: 'a.js' }), final()], {
    'filesystem.readTextFile': ({ path }) => {
      controller.abort();
      return record(path);
    },
  });
  await assert.rejects(run(io, { signal: controller.signal }), {
    code: 'E_ABORTED',
  });
  assert.equal(io.prompts.length, 1);
  assert.equal(io.calls.length, 1);
});

test('progress-boundary cancellation prevents the next model call', async () => {
  const controller = new AbortController();
  const io = scripted([final()]);
  await assert.rejects(
    run(io, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    { code: 'E_ABORTED' }
  );
  assert.deepEqual(io.prompts, []);
});

test('controlled deadline aborts an uncooperative model and releases admission', async (t) => {
  const { rootPath, outputDir } = await workspace(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = Promise.withResolvers();
  let modelSignal;
  const io = scripted([
    ({ signal }) => {
      modelSignal = signal;
      entered.resolve();
      return new Promise(() => {});
    },
    final(),
  ]);
  const { reviewer, admission } = orchestrator(io, outputDir, {
    investigation: { timeoutMs: 100 },
  });
  const pending = reviewer.review({
    rootPath,
    request: 'r',
    investigate: true,
  });
  const rejected = assert.rejects(pending, { code: 'E_INVESTIGATION_TIMEOUT' });
  await entered.promise;
  assert.equal(admission.stats().active, 1);
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(modelSignal.aborted, true);
  assert.equal(modelSignal.reason.code, 'E_INVESTIGATION_TIMEOUT');
  assert.equal(admission.stats().active, 0);
  const next = await reviewer.review({
    rootPath,
    request: 'r',
    investigate: true,
  });
  assert.equal(next.investigation.stopReason, 'final');
  assert.equal(admission.stats().active, 0);
  assert.equal((await readdir(outputDir)).length, 1);
});

test('controlled tool timeout is recoverable and reaches the following model turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = Promise.withResolvers();
  let toolSignal;
  const io = scripted([tool('readTextFile', { path: 'a.js' }), final()], {
    'filesystem.readTextFile': ({ signal }) => {
      toolSignal = signal;
      entered.resolve();
      return new Promise(() => {});
    },
  });
  const pending = run(io, {
    config: config({ limits: { subprocessTimeoutMs: 25 } }),
  });
  await entered.promise;
  t.mock.timers.tick(25);
  const result = await pending;
  assert.equal(toolSignal.aborted, true);
  assert.equal(
    body(io.prompts[1]).navigation[0].error.code,
    'E_SUBPROCESS_TIMEOUT'
  );
  assert.equal(result.investigation.stopReason, 'final');
});

test('external cancellation releases admission and does not persist a partial review', async (t) => {
  const { rootPath, outputDir } = await workspace(t);
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  const io = scripted([
    () => {
      entered.resolve();
      return new Promise(() => {});
    },
  ]);
  const { reviewer, admission } = orchestrator(io, outputDir);
  const pending = reviewer.review({
    rootPath,
    request: 'r',
    investigate: true,
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending, { code: 'E_ABORTED' });
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(admission.stats().active, 0);
  await assert.rejects(readdir(outputDir), { code: 'ENOENT' });
});

test('controlled investigation deadline aborts tool work rather than treating it as a recoverable tool timeout', async (t) => {
  const { rootPath, outputDir } = await workspace(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = Promise.withResolvers();
  let toolSignal;
  const io = scripted([tool('readTextFile', { path: 'a.js' })], {
    'filesystem.readTextFile': ({ signal }) => {
      toolSignal = signal;
      entered.resolve();
      return new Promise(() => {});
    },
  });
  const { reviewer, admission } = orchestrator(io, outputDir, {
    investigation: { timeoutMs: 100 },
    limits: { subprocessTimeoutMs: 200 },
  });
  const pending = reviewer.review({
    rootPath,
    request: 'r',
    investigate: true,
  });
  const rejected = assert.rejects(pending, { code: 'E_INVESTIGATION_TIMEOUT' });
  await entered.promise;
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(toolSignal.aborted, true);
  assert.equal(toolSignal.reason.code, 'E_INVESTIGATION_TIMEOUT');
  assert.equal(io.prompts.length, 1);
  assert.equal(admission.stats().active, 0);
  await assert.rejects(readdir(outputDir), { code: 'ENOENT' });
});

test('queued investigation cancellation leaves the active admission untouched', async (t) => {
  const { rootPath, outputDir } = await workspace(t);
  const io = scripted([final()]);
  const { reviewer, admission } = orchestrator(io, outputDir);
  await admission.acquire();
  const controller = new AbortController();
  const pending = reviewer.review({
    rootPath,
    request: 'r',
    investigate: true,
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending, { code: 'E_ABORTED' });
  controller.abort();
  await rejected;
  assert.equal(admission.stats().active, 1);
  assert.equal(admission.stats().queued, 0);
  assert.deepEqual(io.calls, []);
  assert.deepEqual(io.prompts, []);
  admission.release();
});

test('model response byte limits apply before dispatching otherwise valid tool actions', async () => {
  const io = scripted([tool('searchText', { pattern: 'x'.repeat(100) })]);
  await assert.rejects(
    run(io, {
      config: config({ model: { maxResponseBytes: 80 } }),
    }),
    { code: 'E_MODEL_RESPONSE_TOO_LARGE' }
  );
  assert.deepEqual(io.calls, []);
});
