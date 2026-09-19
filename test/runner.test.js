import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSubprocessRunner } from '../src/subprocess/runner.js';

function fakeSpawnFactory(exitCode = 0, stdoutChunk = 'out', stderrChunk = '') {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    queueMicrotask(() => {
      proc.stdout.emit('data', Buffer.from(stdoutChunk));
      if (stderrChunk) proc.stderr.emit('data', Buffer.from(stderrChunk));
      proc.emit('close', exitCode, null);
    });
    return proc;
  };
}

test('runner settles once with bounded output', async () => {
  const runner = createSubprocessRunner({
    spawn: fakeSpawnFactory(0, '1234567890'),
  });
  const result = await runner.run('x', [], { stdoutMaxBytes: 5 });
  assert.equal(result.stdout, '12345');
  assert.equal(result.stdoutTruncated, true);
});

test('runner maps missing executable to stable code', async () => {
  const runner = createSubprocessRunner({
    spawn: () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      queueMicrotask(() =>
        proc.emit(
          'error',
          Object.assign(new Error('missing'), { code: 'ENOENT' })
        )
      );
      return proc;
    },
  });
  await assert.rejects(() => runner.run('fd', []), {
    code: 'E_EXECUTABLE_NOT_FOUND',
  });
});
