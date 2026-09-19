import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { persistRunArtifacts } from '../src/audit/manifest.js';
import { createReviewOrchestrator } from '../src/orchestrator/reviewOrchestrator.js';
import { createAdmissionController } from '../src/admission/controller.js';
import { createLifecycleManager } from '../src/lifecycle/manager.js';
import { resolveRuntimeConfig } from '../src/config.js';
import { HarnessError } from '../src/errors.js';
import { cancellable } from '../src/orchestrator/investigationLoop.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t) {
  const base = join(process.cwd(), `.audit-test-${randomUUID()}`);
  const reviewedRoot = join(base, 'repo');
  const outputDir = join(base, 'output');
  await fs.mkdir(reviewedRoot, { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return {
    reviewedRoot,
    outputDir,
    runId: 'run',
    manifest: { status: 'success' },
    replayBundle: { sanitized: true },
  };
}

function blockedFilesystem(method, basename) {
  const entered = deferred();
  const release = deferred();
  const cleaned = deferred();
  const removals = [];
  let intercepted = false;
  const filesystem = {
    ...fs,
    async [method](...args) {
      if (!intercepted && args[0].endsWith(basename)) {
        intercepted = true;
        entered.resolve(args);
        await release.promise;
        // Simulate IO which finishes despite an abort, then verify late cleanup.
        if (method === 'writeFile') {
          assert.ok(args[2].signal);
          args[2] = { ...args[2], signal: undefined };
        }
      }
      return fs[method](...args);
    },
    async rm(path, options) {
      const removal = fs.rm(path, options);
      removals.push(removal);
      await removal;
      if (options.recursive) cleaned.resolve();
    },
  };
  return {
    filesystem,
    entered,
    release,
    async cleanup() {
      await cleaned.promise;
      await Promise.all(removals);
    },
  };
}

test('artifacts publish replay first and the success manifest last', async (t) => {
  const inputs = await fixture(t);
  const published = [];
  const result = await persistRunArtifacts({
    ...inputs,
    filesystem: {
      ...fs,
      async link(source, destination) {
        published.push(destination);
        await fs.link(source, destination);
      },
    },
  });
  assert.deepEqual(published, [result.replayPath, result.manifestPath]);
  assert.deepEqual((await fs.readdir(inputs.outputDir)).sort(), [
    'run.manifest.json',
    'run.replay.json',
  ]);
  assert.deepEqual(
    JSON.parse(await fs.readFile(result.manifestPath, 'utf8')),
    inputs.manifest
  );
});

for (const [method, basename] of [
  ['writeFile', 'manifest.json'],
  ['writeFile', 'replay.json'],
  ['link', 'replay.json'],
  ['link', 'manifest.json'],
]) {
  test(`aborting blocked ${method} ${basename} rejects promptly and cleans late IO`, async (t) => {
    const inputs = await fixture(t);
    const controller = new AbortController();
    const blocked = blockedFilesystem(method, basename);
    const pending = cancellable(
      () =>
        persistRunArtifacts({
          ...inputs,
          signal: controller.signal,
          filesystem: blocked.filesystem,
        }),
      controller.signal
    );
    await blocked.entered.promise;
    controller.abort();
    await assert.rejects(pending, { code: 'E_ABORTED' });
    blocked.release.resolve();
    await blocked.cleanup();
    assert.deepEqual(await fs.readdir(inputs.outputDir), []);
    assert.deepEqual(await fs.readdir(inputs.reviewedRoot), []);
  });
}

test('a failed publication removes only files created by this run', async (t) => {
  const inputs = await fixture(t);
  await fs.mkdir(inputs.outputDir);
  await fs.writeFile(join(inputs.outputDir, 'run.manifest.json'), 'existing');
  await assert.rejects(() => persistRunArtifacts(inputs), { code: 'EEXIST' });
  assert.deepEqual(await fs.readdir(inputs.outputDir), ['run.manifest.json']);
  assert.equal(
    await fs.readFile(join(inputs.outputDir, 'run.manifest.json'), 'utf8'),
    'existing'
  );
});

for (const code of ['E_ABORTED', 'E_INVESTIGATION_TIMEOUT']) {
  test(`orchestration releases admission during blocked persistence on ${code}`, async (t) => {
    const inputs = await fixture(t);
    const blocked = blockedFilesystem('writeFile', 'manifest.json');
    const admission = createAdmissionController({ maxActive: 1, maxQueued: 1 });
    const lifecycle = createLifecycleManager({
      admission,
      shutdownGraceMs: 1,
      shutdownDeadlineMs: 2,
    });
    const config = resolveRuntimeConfig({});
    config.review.outputDir = inputs.outputDir;
    if (code === 'E_INVESTIGATION_TIMEOUT') {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      config.investigation.timeoutMs = 100;
    }
    const controller = new AbortController();
    let modelCalls = 0;
    let toolCalls = 0;
    const orchestrator = createReviewOrchestrator({
      config,
      admission,
      lifecycle,
      capabilities: {
        get() {
          toolCalls += 1;
          assert.fail('No tool calls expected.');
        },
      },
      provider: {
        async complete() {
          modelCalls += 1;
          return {
            action: 'final',
            review: {
              schemaVersion: '1.0.0',
              summary: 'ok',
              decision: 'no_findings_in_supplied_evidence',
              observations: [],
              inferences: [],
              findings: [],
              limitations: { notes: [], omittedEvidenceIds: [] },
            },
          };
        },
      },
      persistArtifacts: (options) =>
        persistRunArtifacts({ ...options, filesystem: blocked.filesystem }),
    });
    const pending = orchestrator.review({
      rootPath: inputs.reviewedRoot,
      request: 'Review repository',
      investigate: true,
      includeReplay: true,
      signal: controller.signal,
    });
    await blocked.entered.promise;
    assert.equal(admission.stats().active, 1);
    if (code === 'E_INVESTIGATION_TIMEOUT') t.mock.timers.tick(100);
    else
      controller.abort(new HarnessError(code, 'Private cancellation reason.'));
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, code);
      assert.equal(error.details.stage, 'artifacts');
      assert.equal(error.details.investigation.modelCalls, 1);
      assert.doesNotMatch(JSON.stringify(error), /Private cancellation/);
      return true;
    });
    assert.equal(admission.stats().active, 0);
    assert.equal(modelCalls, 1);
    assert.equal(toolCalls, 0);
    blocked.release.resolve();
    await blocked.cleanup();
    assert.deepEqual(await fs.readdir(inputs.outputDir), []);
  });
}
