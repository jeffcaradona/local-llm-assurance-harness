import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSubprocessRunner } from '../src/subprocess/runner.js';

function createChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  return child;
}

function createTrackedSignal() {
  const listeners = new Set();
  return {
    get aborted() {
      return this._aborted ?? false;
    },
    addEventListener(type, listener) {
      if (type === 'abort') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'abort') listeners.delete(listener);
    },
    abort() {
      this._aborted = true;
      for (const listener of [...listeners]) listener();
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function createRunner(child, options = {}) {
  return createSubprocessRunner({
    spawn: () => child,
    platform: 'linux',
    terminationGraceMs: 50,
    ...options,
  });
}

function observeSettlement(promise) {
  let count = 0;
  const observed = promise.then(
    (value) => {
      count += 1;
      return { value };
    },
    (error) => {
      count += 1;
      return { error };
    }
  );
  return { observed, count: () => count };
}

function assertCleanedUp(child, signal) {
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
  assert.equal(signal?.listenerCount() ?? 0, 0);
}

test('runner returns a structured bounded result on normal close', async () => {
  const child = createChild();
  const signal = createTrackedSignal();
  const pending = createRunner(child).run('x', [], {
    signal,
    stdoutMaxBytes: 5,
  });

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
  assertCleanedUp(child, signal);
});

test('runner rejects abort but observes direct-child close during grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = createChild();
  const signal = createTrackedSignal();
  const pending = createRunner(child).run('x', [], {
    signal,
    timeoutMs: 100,
  });

  signal.abort();
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  assert.equal(child.listenerCount('close'), 1);
  child.emit('close', null, 'SIGTERM');
  t.mock.timers.tick(1_000);

  await assert.rejects(pending, { code: 'E_ABORTED' });
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  assertCleanedUp(child, signal);
});

test('runner rejects timeout but observes direct-child close during grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = createChild();
  const signal = createTrackedSignal();
  const pending = createRunner(child).run('rg', [], {
    signal,
    timeoutMs: 100,
  });

  t.mock.timers.tick(100);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  t.mock.timers.tick(1_000);

  await assert.rejects(pending, {
    code: 'E_SUBPROCESS_TIMEOUT',
    details: { command: 'rg' },
  });
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  assertCleanedUp(child, signal);
});

test('runner escalates when direct child does not exit during grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = createChild();
  const signal = createTrackedSignal();
  const pending = createRunner(child).run('x', [], {
    signal,
    timeoutMs: 100,
  });

  t.mock.timers.tick(100);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  assert.equal(child.listenerCount('close'), 1);
  t.mock.timers.tick(49);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  t.mock.timers.tick(1);

  await assert.rejects(pending, { code: 'E_SUBPROCESS_TIMEOUT' });
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  assertCleanedUp(child, signal);
});

test('runner uses the strongest available direct-child retry on Windows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = createChild();
  const signal = createTrackedSignal();
  const pending = createRunner(child, { platform: 'win32' }).run('x', [], {
    signal,
    timeoutMs: 100,
  });

  signal.abort();
  t.mock.timers.tick(50);

  await assert.rejects(pending, { code: 'E_ABORTED' });
  assert.deepEqual(child.killSignals, [undefined, 'SIGKILL']);
  assertCleanedUp(child, signal);
});

test('late close after spawn error cannot settle the caller again', async () => {
  const child = createChild();
  const signal = createTrackedSignal();
  const settlement = observeSettlement(
    createRunner(child).run('fd', [], { signal })
  );

  child.emit(
    'error',
    Object.assign(new Error('missing'), { code: 'ENOENT' })
  );
  child.emit('close', 0, null);

  const { error } = await settlement.observed;
  assert.equal(error.code, 'E_EXECUTABLE_NOT_FOUND');
  assert.equal(settlement.count(), 1);
  assertCleanedUp(child, signal);
});

for (const scenario of [
  {
    name: 'abort wins timeout and close',
    act({ child, signal, timers }) {
      signal.abort();
      timers.tick(100);
      child.emit('close', null, 'SIGTERM');
    },
    code: 'E_ABORTED',
  },
  {
    name: 'timeout wins abort and close',
    act({ child, signal, timers }) {
      timers.tick(100);
      signal.abort();
      child.emit('close', null, 'SIGTERM');
    },
    code: 'E_SUBPROCESS_TIMEOUT',
  },
  {
    name: 'close wins abort and timeout',
    act({ child, signal, timers }) {
      child.emit('close', 0, null);
      signal.abort();
      timers.tick(100);
    },
    exitCode: 0,
  },
]) {
  test(`runner settles exactly once when ${scenario.name}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = createChild();
    const signal = createTrackedSignal();
    const settlement = observeSettlement(
      createRunner(child).run('x', [], { signal, timeoutMs: 100 })
    );

    scenario.act({ child, signal, timers: t.mock.timers });
    const outcome = await settlement.observed;

    assert.equal(settlement.count(), 1);
    if (scenario.code) assert.equal(outcome.error.code, scenario.code);
    else assert.equal(outcome.value.exitCode, scenario.exitCode);
    assertCleanedUp(child, signal);
  });
}
