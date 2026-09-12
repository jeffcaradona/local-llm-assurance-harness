import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('replay command requires bundle path', async () => {
  await assert.rejects(() => runCli({ argv: ['replay'] }), { code: 'E_REPLAY_BUNDLE_REQUIRED' });
});

test('replay command renders terminal output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-replay-'));
  const bundlePath = join(dir, 'bundle.json');
  await writeFile(
    bundlePath,
    JSON.stringify({
      runId: 'r1',
      includedEvidenceIds: ['ev-0001'],
      omittedEvidenceIds: [],
      review: {
        schemaVersion: '1.0.0',
        summary: 'ok',
        decision: 'no_findings_in_supplied_evidence',
        observations: [],
        inferences: [],
        findings: [],
        limitations: { notes: [], omittedEvidenceIds: [] }
      }
    })
  );
  const stdout = capture();
  const exitCode = await runCli({ argv: ['replay', '--bundle', bundlePath], stdout: stdout.stream, stderr: stdout.stream });
  assert.equal(exitCode, 0);
  assert.match(stdout.text, /Decision:/);
});
