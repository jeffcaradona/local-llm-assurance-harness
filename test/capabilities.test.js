import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCapabilityRegistry,
  isLikelySensitivePath,
} from '../src/capabilities/registry.js';
import Ajv from 'ajv';

test('blocks option injection and sensitive paths', async () => {
  const collector = {
    readTextFile: async () => ({
      content: '',
      lineStart: 1,
      lineEnd: 1,
      retainedBytes: 0,
      originalBytes: 0,
      truncated: false,
      redaction: {},
    }),
    findFiles: async () => [],
    searchText: async () => [],
  };
  const registry = createCapabilityRegistry({ rootPath: '/repo', collector });

  await assert.rejects(
    () => registry.get('filesystem.readTextFile').invoke({ path: '-rf' }),
    { code: 'E_CAPABILITY_INPUT_INVALID' }
  );
  await assert.rejects(
    () => registry.get('filesystem.readTextFile').invoke({ path: '.env' }),
    { code: 'E_SENSITIVE_PATH_BLOCKED' }
  );
  await assert.doesNotReject(() =>
    registry.get('filesystem.readTextFile').invoke({ path: '.env.example' })
  );
  await assert.rejects(
    () => registry.get('filesystem.searchText').invoke({ pattern: '--json' }),
    { code: 'E_CAPABILITY_INPUT_INVALID' }
  );
});

test('filters sensitive search matches without substring false positives', async () => {
  const collector = {
    readTextFile: async () => ({}),
    findFiles: async () => [],
    searchText: async () => [
      { relativePath: '.npmrc' },
      { relativePath: 'docs/secrets-rotation.md' },
      { relativePath: 'keys/client.p12' },
    ],
  };
  const registry = createCapabilityRegistry({ rootPath: '/repo', collector });
  const matches = await registry
    .get('filesystem.searchText')
    .invoke({ pattern: 'token' });
  assert.deepEqual(matches, [{ relativePath: 'docs/secrets-rotation.md' }]);
});

test('sensitive path policy handles Windows and POSIX components', () => {
  for (const path of [
    '.env',
    '.env.local',
    '.env.production',
    '.env-backup',
    '.env_local',
    '.envrc',
    '.ENV.test',
    'config\\.kube\\config',
    '.kube/config',
    '.ssh/config',
    '.aws/config',
    '.azure/accessTokens.json',
    '.gnupg/pubring.kbx',
    'config\\credentials\\token.txt',
    'secrets/nested/key',
    'keys\\CLIENT.PEM',
    '.env.local. ',
    '.env.example/../.env',
  ]) {
    assert.equal(isLikelySensitivePath(path), true, path);
  }
  for (const path of [
    '.env.example',
    'docs\\.env.example',
    'docs/secrets-rotation.md',
    'src/credentials.js',
  ]) {
    assert.equal(isLikelySensitivePath(path), false, path);
  }
});

test('registry names cannot resolve inherited object properties', () => {
  const registry = createCapabilityRegistry({
    rootPath: '/repo',
    collector: {},
  });
  for (const name of [
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'filesystem.exec',
  ]) {
    assert.throws(() => registry.get(name), {
      code: 'E_CAPABILITY_NOT_ALLOWED',
    });
  }
});

test('discovery and search filter sensitive and out-of-root collector results', async () => {
  const paths = [
    '.env.local',
    'safe.txt',
    '..\\escape',
    '/outside.txt',
    'C:\\outside.txt',
    '.kube\\config',
    'secrets\\nested.txt',
  ];
  const registry = createCapabilityRegistry({
    rootPath: '/repo',
    collector: {
      findFiles: async () => paths,
      searchText: async () => paths.map((relativePath) => ({ relativePath })),
    },
  });
  assert.deepEqual(await registry.get('filesystem.findFiles').invoke({}), [
    'safe.txt',
  ]);
  assert.deepEqual(
    await registry.get('filesystem.searchText').invoke({ pattern: 'x' }),
    [{ relativePath: 'safe.txt' }]
  );
});

test('read policy rejects Windows traversal and sensitive variants before collector calls', async () => {
  const registry = createCapabilityRegistry({
    rootPath: '/repo',
    collector: {
      readTextFile: async () => assert.fail('denied read reached collector'),
    },
  });
  for (const path of ['..\\outside', 'C:\\outside', '\\\\host\\share\\file']) {
    await assert.rejects(
      () => registry.get('filesystem.readTextFile').invoke({ path }),
      { code: 'E_PATH_OUT_OF_ROOT' }
    );
  }
  for (const path of [
    '.env.local',
    '.kube\\config',
    '.ssh\\id_rsa',
    'secrets\\data',
  ]) {
    await assert.rejects(
      () => registry.get('filesystem.readTextFile').invoke({ path }),
      { code: 'E_SENSITIVE_PATH_BLOCKED' }
    );
  }
});

test('capability contracts describe actual arguments and validate strictly', () => {
  const registry = createCapabilityRegistry({
    rootPath: '/repo',
    collector: {},
  });
  const ajv = new Ajv({ strict: true });
  for (const [name, input] of [
    ['filesystem.findFiles', { limit: 2 }],
    ['filesystem.readTextFile', { path: 'src/file.js', maxBytes: 2 }],
    ['filesystem.searchText', { pattern: 'literal', maxMatches: 2 }],
  ]) {
    const contract = registry.get(name).inputContract;
    const validate = ajv.compile(contract);
    assert.equal(validate(input), true);
    assert.equal(validate({ ...input, unknown: true }), false);
    for (const property of Object.values(contract.properties)) {
      assert.equal(typeof property.description, 'string');
    }
  }
});

test('invalid argument types and limits are rejected without invoking collectors', async () => {
  const registry = createCapabilityRegistry({
    rootPath: '/repo',
    collector: {},
  });
  for (const [name, input] of [
    ['filesystem.findFiles', { limit: -1 }],
    ['filesystem.readTextFile', { path: 'safe.txt', maxBytes: 0 }],
    ['filesystem.readTextFile', { path: null }],
    ['filesystem.searchText', { pattern: null }],
    ['filesystem.searchText', { pattern: 'x', maxMatches: 1.5 }],
  ]) {
    await assert.rejects(() => registry.get(name).invoke(input), {
      code: 'E_CAPABILITY_INPUT_INVALID',
    });
  }
});

test('registry retains nonenumerable collection metadata while filtering', async () => {
  const files = ['safe.txt', '.env.local'];
  const matches = files.map((relativePath) => ({ relativePath }));
  for (const results of [files, matches]) {
    Object.defineProperties(results, {
      truncated: { value: true },
      omittedCount: { value: 2 },
    });
  }
  const registry = createCapabilityRegistry({
    rootPath: '/repo',
    collector: {
      findFiles: async () => files,
      searchText: async () => matches,
    },
  });
  const discovered = await registry.get('filesystem.findFiles').invoke({});
  const searched = await registry
    .get('filesystem.searchText')
    .invoke({ pattern: 'x' });
  assert.deepEqual(discovered, ['safe.txt']);
  assert.deepEqual(searched, [{ relativePath: 'safe.txt' }]);
  for (const results of [discovered, searched]) {
    assert.equal(results.truncated, true);
    assert.equal(results.omittedCount, 3);
    assert.deepEqual(Object.keys(results), ['0']);
  }
});
