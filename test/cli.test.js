import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { runCli } from '../src/cli.js';

function capture() {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _enc, cb) {
        text += chunk.toString('utf8');
        cb();
      }
    }),
    get text() {
      return text;
    }
  };
}

test('help command prints usage', async () => {
  const stdout = capture();
  const exitCode = await runCli({ argv: ['--help'], stdout: stdout.stream, stderr: stdout.stream });
  assert.equal(exitCode, 0);
  assert.match(stdout.text, /Usage:/);
});
