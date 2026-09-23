import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSubprocessRunner } from '../src/subprocess/runner.js';

function createChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => child.killSignals.push(signal);
  return child;
}

function run(child, options = {}, dependencies = {}) {
  return createSubprocessRunner({
    spawn: () => child,
    platform: 'linux',
    terminationGraceMs: 50,
    ...dependencies,
  }).run('command', [], { timeoutMs: 100, ...options });
}

function assertCleanedUp(child) {
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
}

test('runner returns a structured bounded result on normal close', async () => {
  const child = createChild();
  const pending = run(child, { stdoutMaxBytes: 5 });
  child.stdout.emit('data', Buffer.from('1234567890'));
  child.stderr.emit('data', Buffer.from('warning'));
  child.emit('close', 7, null);

  assert.deepEqual(await pending, {
    exitCode: 7,
    termSignal: null,
    stdout: '12345',
    stderr: 'warning',
    stdoutTruncated: true,
    stderrTruncated: false,
  });
  assert.deepEqual(child.killSignals, []);
  assertCleanedUp(child);
});

test('runner preserves abort while observing direct-child close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = createChild();
  const controller = new AbortController();
  let settlements = 0;
  const pending = run(child, { signal: controller.signal }).finally(
    () => (settlements += 1)
  );

  controller.abort();
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  assert.equal(child.listenerCount('close'), 1);
  child.emit('close', null, 'SIGTERM');
  t.mock.timers.tick(1_000);

  await assert.rejects(pending, { code: 'E_ABORTED' });
  assert.equal(settlements, 1);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  assertCleanedUp(child);
});

test('runner preserves timeout while observing direct-child close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = createChild();
  const pending = run(child);

  t.mock.timers.tick(100);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  t.mock.timers.tick(1_000);

  await assert.rejects(pending, {
    code: 'E_SUBPROCESS_TIMEOUT',
    details: { command: 'command' },
  });
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  assertCleanedUp(child);
});

test('runner escalates and stops observing a direct child after grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [platform, expected] of [
    ['linux', ['SIGTERM', 'SIGKILL']],
    ['win32', [undefined, 'SIGKILL']],
  ]) {
    const child = createChild();
    const controller = new AbortController();
    const pending = run(child, { signal: controller.signal }, { platform });
    controller.abort();
    t.mock.timers.tick(49);
    assert.deepEqual(child.killSignals, expected.slice(0, 1));
    t.mock.timers.tick(1);
    await assert.rejects(pending, { code: 'E_ABORTED' });
    assert.deepEqual(child.killSignals, expected);
    assertCleanedUp(child);
  }
});

test('spawn error wins a late close exactly once', async () => {
  const child = createChild();
  let settlements = 0;
  const pending = run(child).then(
    () => (settlements += 1),
    (error) => {
      settlements += 1;
      throw error;
    }
  );
  child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  child.emit('close', 0, null);

  await assert.rejects(pending, { code: 'E_EXECUTABLE_NOT_FOUND' });
  assert.equal(settlements, 1);
  assertCleanedUp(child);
});

for (const [name, first, code] of [
  ['abort wins timeout and close', 'abort', 'E_ABORTED'],
  ['timeout wins abort and close', 'timeout', 'E_SUBPROCESS_TIMEOUT'],
  ['close wins abort and timeout', 'close', undefined],
]) {
  test(`runner settles exactly once when ${name}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = createChild();
    const controller = new AbortController();
    let settlements = 0;
    const pending = run(child, { signal: controller.signal }).then(
      (value) => {
        settlements += 1;
        return value;
      },
      (error) => {
        settlements += 1;
        throw error;
      }
    );

    if (first === 'abort') controller.abort();
    else if (first === 'timeout') t.mock.timers.tick(100);
    else child.emit('close', 0, null);
    controller.abort();
    t.mock.timers.tick(100);
    child.emit('close', 0, null);

    if (code) await assert.rejects(pending, { code });
    else assert.equal((await pending).exitCode, 0);
    assert.equal(settlements, 1);
    assertCleanedUp(child);
  });
}
