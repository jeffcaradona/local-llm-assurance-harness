import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFilesystemCollector } from '../src/filesystem/collector.js';
import { createRedactor } from '../src/redaction.js';
import { createCapabilityRegistry } from '../src/capabilities/registry.js';

const limits = {
  subprocessTimeoutMs: 1000,
  subprocessStdoutBytes: 10000,
  subprocessStderrBytes: 10000,
  maxFileBytes: 1000,
  maxSearchMatches: 10,
  maxFiles: 10,
  maxEvidenceBytes: 10000,
};

async function fixture(t) {
  const directory = join('test', `.collector-fixture-${randomUUID()}`);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return resolve(directory);
}

test('rg exit code 1 is empty result', async (t) => {
  const root = await fixture(t);
  const runner = { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) };
  const collector = createFilesystemCollector({
    rootPath: root,
    runner,
    limits,
    redactor: createRedactor(),
  });
  const results = await collector.searchText({ pattern: 'x' });
  assert.deepEqual(results, []);
});

test('malformed rg json is rejected', async (t) => {
  const root = await fixture(t);
  const runner = {
    run: async () => ({ exitCode: 0, stdout: '{bad', stderr: '' }),
  };
  const collector = createFilesystemCollector({
    rootPath: root,
    runner,
    limits,
    redactor: createRedactor(),
  });
  await assert.rejects(() => collector.searchText({ pattern: 'x' }), {
    code: 'E_SEARCH_OUTPUT_INVALID',
  });
});

test('invalid search records fail with stable errors rather than raw exceptions', async (t) => {
  const root = await fixture(t);
  for (const stdout of ['null', '[]', '1', '{"type":"match","data":null}']) {
    const collector = createFilesystemCollector({
      rootPath: root,
      runner: { run: async () => ({ exitCode: 0, stdout, stderr: '' }) },
      limits,
      redactor: createRedactor(),
    });
    await assert.rejects(() => collector.searchText({ pattern: 'x' }), {
      code: 'E_SEARCH_OUTPUT_INVALID',
    });
  }
});

test('search byte metadata measures original and retained redacted content', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'match.txt'), 'token=short');
  const original = 'token=short';
  const collector = createFilesystemCollector({
    rootPath: root,
    runner: {
      run: async () => ({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          type: 'match',
          data: {
            path: { text: 'match.txt' },
            line_number: 1,
            lines: { text: original },
          },
        }),
      }),
    },
    limits,
    redactor: createRedactor(),
  });

  const [match] = await collector.searchText({ pattern: 'token' });

  assert.equal(match.content, 'token=[REDACTED_FIELD]');
  assert.equal(match.originalBytes, Buffer.byteLength(original));
  assert.equal(match.retainedBytes, Buffer.byteLength(match.content));
  assert.notEqual(match.retainedBytes, match.originalBytes);
});

test('already aborted read is rejected', async (t) => {
  const root = await fixture(t);
  const file = join(root, 'a.txt');
  await writeFile(file, 'hello');
  const collector = createFilesystemCollector({
    rootPath: root,
    runner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    limits,
    redactor: createRedactor(),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      collector.readTextFile({
        path: 'a.txt',
        signal: controller.signal,
        maxBytes: 10,
      }),
    { code: 'E_ABORTED' }
  );
});

test(
  'symlink that escapes root is rejected',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await fixture(t);
    const outside = await fixture(t);
    const outsideFile = join(outside, 'secret.txt');
    await writeFile(outsideFile, 'secret');
    await mkdir(join(root, 'dir'));
    const linkPath = join(root, 'dir', 'link.txt');
    await symlink(outsideFile, linkPath);

    const collector = createFilesystemCollector({
      rootPath: root,
      runner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      limits,
      redactor: createRedactor(),
    });
    await assert.rejects(
      () => collector.readTextFile({ path: 'dir/link.txt', maxBytes: 10 }),
      { code: 'E_PATH_OUT_OF_ROOT' }
    );
  }
);

test('fd discovery excludes internal directories and normalizes relative paths', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# test');
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: test');
  const seen = { args: [] };
  const runner = {
    run: async (_cmd, args) => {
      seen.args = args;
      return {
        exitCode: 0,
        stdout: `${join(root, 'README.md')}\n${join(root, '.github', 'workflows', 'ci.yml')}\n`,
        stderr: '',
      };
    },
  };
  const collector = createFilesystemCollector({
    rootPath: root,
    runner,
    limits,
    redactor: createRedactor(),
  });
  const files = await collector.findFiles({});
  assert.match(seen.args.join(' '), /--exclude \.git/);
  assert.match(seen.args.join(' '), /--exclude node_modules/);
  assert.deepEqual(files, ['.github/workflows/ci.yml', 'README.md']);
});

test('discovery and search skip denied paths before returning evidence', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const denied = [
    '.env',
    '.env.local',
    '.kube/config',
    '.aws/credentials',
    'secrets/token.txt',
  ];
  for (const name of [...denied, 'src/allowed.txt', '.env.example']) {
    await mkdir(resolve(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), 'evidence');
  }
  await writeFile(join(outside, 'outside.txt'), 'outside');
  const paths = [
    ...denied,
    join(outside, 'outside.txt'),
    '..\\outside.txt',
    'C:\\outside.txt',
    'missing.txt',
    'src',
    'src\\allowed.txt',
    '.env.example',
  ];
  if (process.platform !== 'win32') {
    await symlink(join(root, '.kube'), join(root, 'alias'));
    await symlink(join(root, 'src'), join(root, 'source-alias'));
    await symlink(join(root, 'src', 'allowed.txt'), join(root, 'linked.txt'));
    paths.push('alias/config', 'source-alias/allowed.txt', 'linked.txt');
  }
  const runner = {
    run: async (command) => ({
      exitCode: 0,
      stderr: '',
      stdout:
        command === 'fd'
          ? paths.join('\n')
          : paths
              .map((path) =>
                JSON.stringify({
                  type: 'match',
                  data: {
                    path: { text: path },
                    line_number: 1,
                    lines: { text: 'evidence' },
                  },
                })
              )
              .join('\n'),
    }),
  };
  const collector = createFilesystemCollector({
    rootPath: root,
    runner,
    limits,
    redactor: createRedactor(),
  });
  assert.deepEqual(await collector.findFiles({}), [
    '.env.example',
    'src/allowed.txt',
  ]);
  assert.deepEqual(
    (await collector.searchText({ pattern: 'evidence' })).map(
      (match) => match.relativePath
    ),
    ['.env.example', 'src/allowed.txt']
  );
  for (const path of denied) {
    await assert.rejects(() => collector.readTextFile({ path }), {
      code: 'E_SENSITIVE_PATH_BLOCKED',
    });
  }
  if (process.platform !== 'win32') {
    await assert.rejects(
      () => collector.readTextFile({ path: 'alias/config' }),
      { code: 'E_SENSITIVE_PATH_BLOCKED' }
    );
    await assert.rejects(
      () => collector.readTextFile({ path: 'source-alias/allowed.txt' }),
      { code: 'E_SYMLINK_BLOCKED' }
    );
    await assert.rejects(() => collector.readTextFile({ path: 'linked.txt' }), {
      code: 'E_SYMLINK_BLOCKED',
    });
  }
});

test('native reads normalize paths, enforce bounds and reject unsupported files', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'src', 'file.txt'),
    'a'.repeat(limits.maxFileBytes + 1)
  );
  await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]));
  const collector = createFilesystemCollector({
    rootPath: root,
    runner: {},
    limits,
    redactor: createRedactor(),
  });
  const result = await collector.readTextFile({
    path: 'src\\file.txt',
    maxBytes: limits.maxFileBytes * 2,
  });
  assert.equal(result.relativePath, 'src/file.txt');
  assert.equal(result.retainedBytes, limits.maxFileBytes);
  assert.equal(result.truncated, true);
  assert.equal(
    (await collector.readTextFile({ path: 'src/file.txt', maxBytes: 2 }))
      .content,
    'aa'
  );
  await assert.rejects(() => collector.readTextFile({ path: 'src' }), {
    code: 'E_CAPABILITY_INPUT_INVALID',
  });
  await assert.rejects(() => collector.readTextFile({ path: 'binary' }), {
    code: 'E_BINARY_FILE_REJECTED',
  });
  await assert.rejects(() => collector.readTextFile({ path: 'missing' }), {
    code: 'E_FILE_NOT_FOUND',
  });
  for (const path of [
    '../outside',
    '..\\outside',
    'C:\\outside',
    '\\\\server\\share\\file',
  ]) {
    await assert.rejects(() => collector.readTextFile({ path }), {
      code: 'E_PATH_OUT_OF_ROOT',
    });
  }
  for (const maxBytes of [0, -1, 1.5, Infinity]) {
    await assert.rejects(
      () => collector.readTextFile({ path: 'src/file.txt', maxBytes }),
      { code: 'E_CAPABILITY_INPUT_INVALID' }
    );
  }
});

test('discovery and search honor cancellation before and after subprocesses', async (t) => {
  const root = await fixture(t);
  for (const operation of ['findFiles', 'searchText']) {
    const controller = new AbortController();
    let calls = 0;
    const collector = createFilesystemCollector({
      rootPath: root,
      limits,
      redactor: createRedactor(),
      runner: {
        run: async () => {
          calls += 1;
          controller.abort();
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
    });
    await assert.rejects(
      () => collector[operation]({ signal: controller.signal, pattern: 'x' }),
      { code: 'E_ABORTED' }
    );
    assert.equal(calls, 1);
    await assert.rejects(
      () => collector[operation]({ signal: controller.signal, pattern: 'x' }),
      { code: 'E_ABORTED' }
    );
    assert.equal(calls, 1);
  }
});

test('discovery and search clamp caller limits to harness limits', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'allowed.txt'), 'x');
  const collector = createFilesystemCollector({
    rootPath: root,
    limits: { ...limits, maxFiles: 1, maxSearchMatches: 1 },
    redactor: createRedactor(),
    runner: {
      run: async (command, args) => {
        if (command === 'rg')
          assert.equal(args[args.indexOf('--max-count') + 1], '1');
        return {
          exitCode: 0,
          stderr: '',
          stdout:
            command === 'fd'
              ? 'allowed.txt\nallowed.txt\n'
              : [1, 2]
                  .map((line) =>
                    JSON.stringify({
                      type: 'match',
                      data: {
                        path: { text: 'allowed.txt' },
                        line_number: line,
                        lines: { text: 'x' },
                      },
                    })
                  )
                  .join('\n'),
        };
      },
    },
  });
  assert.deepEqual(await collector.findFiles({ limit: 100 }), ['allowed.txt']);
  const matches = await collector.searchText({ pattern: 'x', maxMatches: 100 });
  assert.equal(matches.length, 1);
  assert.equal(matches.truncated, true);
});

test('directory junction aliases are denied for all collection operations', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'actual'));
  await writeFile(join(root, 'actual', 'file.txt'), 'evidence');
  await symlink(join(root, 'actual'), join(root, 'alias'), 'junction');
  const collector = createFilesystemCollector({
    rootPath: root,
    limits,
    redactor: createRedactor(),
    runner: {
      run: async (command) => ({
        exitCode: 0,
        stderr: '',
        stdout:
          command === 'fd'
            ? 'alias/file.txt\n'
            : JSON.stringify({
                type: 'match',
                data: {
                  path: { text: 'alias/file.txt' },
                  line_number: 1,
                  lines: { text: 'evidence' },
                },
              }),
      }),
    },
  });
  assert.deepEqual(await collector.findFiles({}), []);
  assert.deepEqual(await collector.searchText({ pattern: 'evidence' }), []);
  await assert.rejects(
    () => collector.readTextFile({ path: 'alias/file.txt' }),
    { code: 'E_SYMLINK_BLOCKED' }
  );
});

test('stdout truncation remains visible below discovery and search count caps', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'allowed.txt'), 'x');
  const match = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'allowed.txt' },
      line_number: 1,
      lines: { text: 'x' },
    },
  });
  const collector = createFilesystemCollector({
    rootPath: root,
    limits,
    redactor: createRedactor(),
    runner: {
      run: async (command) => ({
        exitCode: 0,
        stderr: '',
        stdout:
          command === 'fd' ? 'allowed.txt\npartial' : `${match}\n{"type":`,
        stdoutTruncated: true,
      }),
    },
  });
  const files = await collector.findFiles({});
  assert.deepEqual(files, ['allowed.txt']);
  const matches = await collector.searchText({ pattern: 'x' });
  assert.equal(matches.length, 1);
  for (const results of [files, matches]) {
    assert.equal(results.truncated, true);
    assert.equal(results.omittedCount, 0);
    assert.equal(Object.keys(results).includes('truncated'), false);
    assert.equal(JSON.stringify(results).includes('truncated":true'), false);
  }
});

test('discovery exposes count truncation separately from policy omissions', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'a.txt'), 'x');
  await writeFile(join(root, 'b.txt'), 'x');
  const collector = createFilesystemCollector({
    rootPath: root,
    limits,
    redactor: createRedactor(),
    runner: {
      run: async () => ({
        exitCode: 0,
        stderr: '',
        stdout: '.env\na.txt\nb.txt\n',
      }),
    },
  });
  const capped = await collector.findFiles({ limit: 1 });
  assert.deepEqual(capped, ['a.txt']);
  assert.equal(capped.truncated, true);
  assert.equal(capped.omittedCount, 2);
  const uncapped = await collector.findFiles({});
  assert.deepEqual(uncapped, ['a.txt', 'b.txt']);
  assert.equal(uncapped.truncated, false);
  assert.equal(uncapped.omittedCount, 1);
});

test('configured root aliases permit selections without permitting aliases below the root', async (t) => {
  const base = await fixture(t);
  const root = join(base, 'repo');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.kube'));
  await mkdir(outside);
  await writeFile(join(root, 'src', 'a.js'), 'evidence');
  await writeFile(join(root, '.kube', 'config'), 'sensitive');
  await writeFile(join(outside, 'a.js'), 'outside');
  await symlink(join(root, 'src'), join(root, 'nested-alias'), 'junction');
  await symlink(outside, join(root, 'escape'), 'junction');
  const aliasTypes =
    process.platform === 'win32' ? ['junction'] : ['junction', 'dir'];
  for (const type of aliasTypes) {
    const alias = join(base, `root-${type}`);
    await symlink(root, alias, type);
    let selected = 'src/a.js';
    const collector = createFilesystemCollector({
      rootPath: alias,
      limits,
      redactor: createRedactor(),
      runner: {
        run: async (command, _args, options) => {
          assert.equal(options.cwd, root);
          const paths = [
            selected,
            join(alias, 'nested-alias', 'a.js'),
            join(alias, 'escape', 'a.js'),
            join(alias, '.kube', 'config'),
            join(outside, 'a.js'),
          ];
          return {
            exitCode: 0,
            stderr: '',
            stdout:
              command === 'fd'
                ? paths.join('\n')
                : paths
                    .map((path) =>
                      JSON.stringify({
                        type: 'match',
                        data: {
                          path: { text: path },
                          line_number: 1,
                          lines: { text: 'evidence' },
                        },
                      })
                    )
                    .join('\n'),
          };
        },
      },
    });
    const registry = createCapabilityRegistry({ rootPath: alias, collector });
    for (const path of ['src/a.js', join(alias, 'src', 'a.js')]) {
      const read = await registry
        .get('filesystem.readTextFile')
        .invoke({ path });
      assert.equal(read.relativePath, 'src/a.js');
      assert.equal(read.content, 'evidence');
    }
    for (const path of [
      'src/a.js',
      join(alias, 'src', 'a.js'),
      join(root, 'src', 'a.js'),
    ]) {
      selected = path;
      assert.deepEqual(await registry.get('filesystem.findFiles').invoke({}), [
        'src/a.js',
      ]);
      const matches = await registry
        .get('filesystem.searchText')
        .invoke({ pattern: 'evidence' });
      assert.equal(matches.length, 1);
      assert.equal(matches[0].relativePath, 'src/a.js');
    }
    for (const path of [
      'nested-alias/a.js',
      join(alias, 'nested-alias', 'a.js'),
    ]) {
      await assert.rejects(
        () => registry.get('filesystem.readTextFile').invoke({ path }),
        { code: 'E_SYMLINK_BLOCKED' }
      );
    }
    for (const path of [
      'escape/a.js',
      join(alias, 'escape', 'a.js'),
      '../outside/a.js',
      join(outside, 'a.js'),
    ]) {
      await assert.rejects(
        () => registry.get('filesystem.readTextFile').invoke({ path }),
        { code: 'E_PATH_OUT_OF_ROOT' }
      );
    }
    await assert.rejects(
      () =>
        registry
          .get('filesystem.readTextFile')
          .invoke({ path: join(alias, '.kube', 'config') }),
      { code: 'E_SENSITIVE_PATH_BLOCKED' }
    );
  }
});
