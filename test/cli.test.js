import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { compilePromptContext } from '../src/context/compiler.js';

function capture() {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _enc, cb) {
        text += chunk.toString('utf8');
        cb();
      },
    }),
    get text() {
      return text;
    },
  };
}

async function fixture(t) {
  const dir = join(process.cwd(), `.cli-test-${randomUUID()}`);
  await mkdir(dir);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('help command prints usage', async () => {
  const stdout = capture();
  const exitCode = await runCli({
    argv: ['--help'],
    stdout: stdout.stream,
    stderr: stdout.stream,
  });
  assert.equal(exitCode, 0);
  assert.match(stdout.text, /Usage:/);
  assert.match(stdout.text, /--investigate/);
});

test('investigate is a strict review-only boolean option', async () => {
  for (const argv of [
    ['review', '--investigate', 'true'],
    ['review', '--investigate', 'false'],
    ['review', '--investigate', ''],
    ['review', '--investigate=true'],
    ['review', '--investigate=false'],
    ['review', '--investigate='],
    ['review', '--investigate', '--investigate'],
    ['replay', '--investigate'],
    ['replay', '--investigate=true'],
  ]) {
    await assert.rejects(() => runCli({ argv, env: {} }), {
      code: 'E_CLI_OPTION_INVALID',
    });
  }
});

test('review accepts investigate without a value', async () => {
  await assert.rejects(
    () => runCli({ argv: ['review', '--investigate'], env: {} }),
    { code: 'E_REVIEW_REQUEST_REQUIRED' }
  );
});

test('review JSON stdout is parseable and artifact notices use stderr', async (t) => {
  const dir = await fixture(t);
  const root = join(dir, 'repo');
  await mkdir(root);
  await writeFile(join(root, 'sample.js'), 'export const value = 1;\n');
  const review = {
    schemaVersion: '1.0.0',
    summary: 'ok',
    decision: 'no_findings_in_supplied_evidence',
    observations: [],
    inferences: [],
    findings: [],
    limitations: { notes: [], omittedEvidenceIds: [] },
  };
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(review) } }],
        })
      )
  );
  const stdout = capture();
  const stderr = capture();
  assert.equal(
    await runCli({
      argv: [
        'review',
        '--root',
        root,
        '--file',
        'sample.js',
        '--request',
        'Review sample',
        '--output-dir',
        join(dir, 'artifacts'),
        '--replay',
        '--format',
        'json',
      ],
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
    }),
    0
  );
  const report = JSON.parse(stdout.text);
  assert.deepEqual(report.review, review);
  assert.equal(report.investigation, undefined);
  assert.match(stderr.text, /^Manifest: .+\nReplay bundle: .+\n$/);
  assert.doesNotMatch(stderr.text, /Investigation/);
  const manifestPath = stderr.text.split('\n')[0].slice('Manifest: '.length);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.request, 'Review sample');
});

test('investigation JSON stays on stdout and persists metadata-only manifest', async (t) => {
  const dir = await fixture(t);
  const root = join(dir, 'repo');
  await mkdir(root);
  const review = {
    schemaVersion: '1.0.0',
    summary: 'ok',
    decision: 'no_findings_in_supplied_evidence',
    observations: [],
    inferences: [],
    findings: [],
    limitations: { notes: [], omittedEvidenceIds: [] },
  };
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: JSON.stringify({ action: 'final', review }) },
            },
          ],
        })
      )
  );
  const stdout = capture();
  const stderr = capture();
  const argv = [
    'review',
    '--root',
    root,
    '--request',
    'Review private-request',
    '--investigate',
    '--format',
    'json',
    '--output-dir',
    join(dir, 'artifacts'),
  ];
  await runCli({
    argv,
    env: {},
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  const report = JSON.parse(stdout.text);
  assert.equal(report.investigation.modelCalls, 1);
  assert.deepEqual(report.review, review);
  assert.equal(report.review.investigation, undefined);
  assert.match(stderr.text, /Investigation progress\./);
  const manifestPath = stderr.text
    .split('\n')
    .find((line) => line.startsWith('Manifest: '))
    .slice('Manifest: '.length);
  const rawManifest = await readFile(manifestPath, 'utf8');
  assert.doesNotMatch(rawManifest, /private-request/);
  assert.equal(JSON.parse(rawManifest).investigation.modelCalls, 1);

  await assert.rejects(
    () =>
      runCli({
        argv: [...argv.slice(0, -1), root],
        env: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    (error) => {
      assert.equal(error.code, 'E_OUTPUT_INSIDE_REPO');
      assert.equal(error.details.stage, 'artifacts');
      assert.equal(error.details.investigation.modelCalls, 1);
      assert.equal(
        error.details.investigation.stopReason,
        'E_OUTPUT_INSIDE_REPO'
      );
      assert.doesNotMatch(
        JSON.stringify(error.details),
        /private-request|\.cli-test-/
      );
      return true;
    }
  );
});

test('investigation instruction failures expose safe metadata without paths', async (t) => {
  const dir = await fixture(t);
  await assert.rejects(
    () =>
      runCli({
        argv: [
          'review',
          '--root',
          dir,
          '--request',
          'Review private-request',
          '--investigate',
          '--instructions',
          join(dir, 'private-instructions'),
        ],
        env: {},
      }),
    (error) => {
      assert.equal(error.details.stage, 'instructions');
      assert.equal(error.details.investigation.modelCalls, 0);
      assert.equal(error.details.investigation.toolCalls, 0);
      assert.equal(error.details.investigation.stopReason, error.code);
      assert.doesNotMatch(
        JSON.stringify({ message: error.message, details: error.details }),
        /private-request|private-instructions|\.cli-test-/
      );
      return true;
    }
  );
});

test('seedless investigation rejects invalid roots before contacting the model', async (t) => {
  const dir = await fixture(t);
  const filePath = join(dir, 'private-file');
  await writeFile(filePath, 'not a directory');
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('Invalid root must not reach the model endpoint.');
  });
  for (const root of [join(dir, 'private-missing-directory'), filePath]) {
    await assert.rejects(
      () =>
        runCli({
          argv: [
            'review',
            '--root',
            root,
            '--request',
            'Review repository',
            '--investigate',
          ],
          env: {},
        }),
      (error) => {
        assert.equal(error.code, 'E_REVIEW_ROOT_INVALID');
        assert.equal(error.details.stage, 'root');
        assert.equal(error.details.investigation.modelCalls, 0);
        assert.equal(error.details.investigation.toolCalls, 0);
        assert.equal(
          error.details.investigation.stopReason,
          'E_REVIEW_ROOT_INVALID'
        );
        assert.doesNotMatch(
          JSON.stringify({ message: error.message, details: error.details }),
          /private-file|private-missing-directory|\.cli-test-/
        );
        return true;
      }
    );
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('replay command requires bundle path', async () => {
  await assert.rejects(() => runCli({ argv: ['replay'] }), {
    code: 'E_REPLAY_BUNDLE_REQUIRED',
  });
});

test('replay command renders terminal output', async (t) => {
  const dir = await fixture(t);
  const bundlePath = join(dir, 'bundle.json');
  const context = await compilePromptContext({
    request: 'Replay request',
    evidence: [],
    instructionFiles: [],
    maxChars: 10_000,
  });
  await writeFile(
    bundlePath,
    JSON.stringify({
      runId: 'r1',
      request: 'Replay request',
      evidence: [],
      maxPromptChars: 10_000,
      systemPrompt: context.systemPrompt,
      userPrompt: context.userPrompt,
      includedEvidenceIds: [],
      omittedEvidenceIds: [],
      review: {
        schemaVersion: '1.0.0',
        summary: 'ok',
        decision: 'no_findings_in_supplied_evidence',
        observations: [],
        inferences: [],
        findings: [],
        limitations: { notes: [], omittedEvidenceIds: [] },
      },
    })
  );
  const stdout = capture();
  const exitCode = await runCli({
    argv: ['replay', '--bundle', bundlePath],
    stdout: stdout.stream,
    stderr: stdout.stream,
  });
  assert.equal(exitCode, 0);
  assert.match(stdout.text, /Decision:/);
});
