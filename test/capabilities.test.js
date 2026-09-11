import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityRegistry } from '../src/capabilities/registry.js';

test('blocks option injection and sensitive paths', async () => {
  const collector = {
    readTextFile: async () => ({ content: '', lineStart: 1, lineEnd: 1, retainedBytes: 0, originalBytes: 0, truncated: false, redaction: {} }),
    findFiles: async () => [],
    searchText: async () => []
  };
  const registry = createCapabilityRegistry({ rootPath: '/repo', collector });

  await assert.rejects(() => registry.get('filesystem.readTextFile').invoke({ path: '-rf' }), { code: 'E_CAPABILITY_INPUT_INVALID' });
  await assert.rejects(() => registry.get('filesystem.readTextFile').invoke({ path: '.env' }), { code: 'E_SENSITIVE_PATH_BLOCKED' });
  await assert.doesNotReject(() => registry.get('filesystem.readTextFile').invoke({ path: '.env.example' }));
  await assert.rejects(() => registry.get('filesystem.searchText').invoke({ pattern: '--json' }), { code: 'E_CAPABILITY_INPUT_INVALID' });
});
