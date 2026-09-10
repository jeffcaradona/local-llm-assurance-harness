import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFilesystemCollector } from '../src/filesystem/collector.js';
import { createRedactor } from '../src/redaction.js';

const limits = {
  subprocessTimeoutMs: 1000,
  subprocessStdoutBytes: 10000,
  subprocessStderrBytes: 10000,
  maxFileBytes: 1000,
  maxSearchMatches: 10,
  maxFiles: 10,
  maxEvidenceBytes: 10000
};

test('rg exit code 1 is empty result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collector-'));
  const runner = { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) };
  const collector = createFilesystemCollector({ rootPath: root, runner, limits, redactor: createRedactor() });
  const results = await collector.searchText({ pattern: 'x' });
  assert.deepEqual(results, []);
});

test('malformed rg json is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collector-'));
  const runner = { run: async () => ({ exitCode: 0, stdout: '{bad', stderr: '' }) };
  const collector = createFilesystemCollector({ rootPath: root, runner, limits, redactor: createRedactor() });
  await assert.rejects(() => collector.searchText({ pattern: 'x' }), { code: 'E_SEARCH_OUTPUT_INVALID' });
});

test('already aborted read is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collector-'));
  const file = join(root, 'a.txt');
  await writeFile(file, 'hello');
  const collector = createFilesystemCollector({ rootPath: root, runner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }, limits, redactor: createRedactor() });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => collector.readTextFile({ absolutePath: file, relativePath: 'a.txt', signal: controller.signal, maxBytes: 10 }),
    { code: 'E_ABORTED' }
  );
});

test('symlink that escapes root is rejected', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'collector-'));
  const outside = await mkdtemp(join(tmpdir(), 'collector-outside-'));
  const outsideFile = join(outside, 'secret.txt');
  await writeFile(outsideFile, 'secret');
  await mkdir(join(root, 'dir'));
  const linkPath = join(root, 'dir', 'link.txt');
  await symlink(outsideFile, linkPath);

  const collector = createFilesystemCollector({ rootPath: root, runner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }, limits, redactor: createRedactor() });
  await assert.rejects(
    () => collector.readTextFile({ absolutePath: linkPath, relativePath: 'dir/link.txt', maxBytes: 10 }),
    { code: 'E_PATH_OUT_OF_ROOT' }
  );
});
