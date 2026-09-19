import { basename, isAbsolute, relative, resolve } from 'node:path';
import { HarnessError } from '../errors.js';

const SENSITIVE_FILE_PATTERNS = [
  '.env',
  '.pem',
  '.key',
  '.kube/config',
  'id_rsa',
  'id_ecdsa',
  'id_ed25519',
  '.npmrc',
  '.netrc',
  '.pfx',
  '.p12',
  'credentials',
  'secrets',
];

export function isLikelySensitivePath(pathText) {
  const lower = pathText.toLowerCase();
  const name = basename(lower);
  if (name === '.env.example') {
    return false;
  }
  return SENSITIVE_FILE_PATTERNS.some((pattern) => {
    if (pattern.startsWith('.') && pattern !== '.env')
      return name.endsWith(pattern);
    return name === pattern || lower.endsWith(`/${pattern}`);
  });
}

function ensureNoOptionInjection(value, field) {
  if (value.startsWith('-')) {
    throw new HarnessError('E_CAPABILITY_INPUT_INVALID', `Invalid ${field}.`, {
      field,
      value,
    });
  }
}

function escapesRoot(relPath) {
  return (
    isAbsolute(relPath) ||
    relPath === '..' ||
    relPath.startsWith('../') ||
    relPath.startsWith('..\\')
  );
}

export function createCapabilityRegistry({ rootPath, collector }) {
  const canonicalRoot = resolve(rootPath);

  function assertInRoot(pathText) {
    const absolute = resolve(canonicalRoot, pathText);
    const rel = relative(canonicalRoot, absolute);
    if (escapesRoot(rel)) {
      throw new HarnessError(
        'E_PATH_OUT_OF_ROOT',
        'Path escapes allowed root.',
        { pathText }
      );
    }
    return absolute;
  }

  const capabilities = {
    'filesystem.findFiles': {
      name: 'filesystem.findFiles',
      riskLevel: 'low',
      timeoutMs: 15_000,
      inputContract: {
        type: 'object',
        required: [],
        additionalProperties: false,
      },
      invoke: async ({ signal, limit }) =>
        collector.findFiles({ signal, limit }),
    },
    'filesystem.readTextFile': {
      name: 'filesystem.readTextFile',
      riskLevel: 'low',
      timeoutMs: 5_000,
      inputContract: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
      },
      invoke: async ({ path, signal, maxBytes }) => {
        ensureNoOptionInjection(path, 'path');
        assertInRoot(path);
        if (isLikelySensitivePath(path)) {
          throw new HarnessError(
            'E_SENSITIVE_PATH_BLOCKED',
            'Sensitive file path blocked by policy.',
            { path }
          );
        }
        return collector.readTextFile({ path, signal, maxBytes });
      },
    },
    'filesystem.searchText': {
      name: 'filesystem.searchText',
      riskLevel: 'medium',
      timeoutMs: 15_000,
      inputContract: {
        type: 'object',
        required: ['pattern'],
        additionalProperties: false,
      },
      invoke: async ({ pattern, signal, maxMatches }) => {
        ensureNoOptionInjection(pattern, 'pattern');
        const matches = await collector.searchText({
          pattern,
          signal,
          maxMatches,
        });
        return matches.filter(
          (match) => !isLikelySensitivePath(match.relativePath)
        );
      },
    },
  };

  return {
    get(name) {
      const capability = capabilities[name];
      if (!capability) {
        throw new HarnessError(
          'E_CAPABILITY_NOT_ALLOWED',
          'Capability not approved.',
          { name }
        );
      }
      return capability;
    },
  };
}
