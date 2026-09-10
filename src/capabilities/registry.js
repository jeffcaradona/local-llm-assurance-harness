import { relative, resolve } from 'node:path';
import { HarnessError } from '../errors.js';

const SENSITIVE_FILE_PATTERNS = [
  '.env',
  '.pem',
  '.key',
  '.kube/config',
  'id_rsa',
  'id_ed25519',
  'credentials',
  'secrets'
];

export function isLikelySensitivePath(pathText) {
  const lower = pathText.toLowerCase();
  return SENSITIVE_FILE_PATTERNS.some((pattern) => lower.includes(pattern));
}

function ensureNoOptionInjection(value, field) {
  if (value.startsWith('-')) {
    throw new HarnessError('E_CAPABILITY_INPUT_INVALID', `Invalid ${field}.`, { field, value });
  }
}

export function createCapabilityRegistry({ rootPath, collector }) {
  const canonicalRoot = resolve(rootPath);

  function assertInRoot(pathText) {
    const absolute = resolve(canonicalRoot, pathText);
    const rel = relative(canonicalRoot, absolute);
    if (rel.startsWith('..') || rel === '') {
      if (rel === '') return absolute;
      throw new HarnessError('E_PATH_OUT_OF_ROOT', 'Path escapes allowed root.', { pathText });
    }
    return absolute;
  }

  const capabilities = {
    'filesystem.findFiles': {
      name: 'filesystem.findFiles',
      riskLevel: 'low',
      timeoutMs: 15_000,
      inputContract: { type: 'object', required: [], additionalProperties: false },
      invoke: async ({ signal, limit }) => collector.findFiles({ signal, limit })
    },
    'filesystem.readTextFile': {
      name: 'filesystem.readTextFile',
      riskLevel: 'low',
      timeoutMs: 5_000,
      inputContract: { type: 'object', required: ['path'], additionalProperties: false },
      invoke: async ({ path, signal, maxBytes }) => {
        ensureNoOptionInjection(path, 'path');
        const absolutePath = assertInRoot(path);
        if (isLikelySensitivePath(path)) {
          throw new HarnessError('E_SENSITIVE_PATH_BLOCKED', 'Sensitive file path blocked by policy.', { path });
        }
        return collector.readTextFile({ absolutePath, relativePath: path, signal, maxBytes });
      }
    },
    'filesystem.searchText': {
      name: 'filesystem.searchText',
      riskLevel: 'medium',
      timeoutMs: 15_000,
      inputContract: { type: 'object', required: ['pattern'], additionalProperties: false },
      invoke: async ({ pattern, signal, maxMatches }) => {
        ensureNoOptionInjection(pattern, 'pattern');
        return collector.searchText({ pattern, signal, maxMatches });
      }
    }
  };

  return {
    get(name) {
      const capability = capabilities[name];
      if (!capability) {
        throw new HarnessError('E_CAPABILITY_NOT_ALLOWED', 'Capability not approved.', { name });
      }
      return capability;
    }
  };
}
