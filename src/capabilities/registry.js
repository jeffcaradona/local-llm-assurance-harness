import { isAbsolute, relative, resolve, win32 } from 'node:path';
import { HarnessError } from '../errors.js';

const SENSITIVE_FILE_PATTERNS = [
  '.pem',
  '.key',
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
  const parts = pathText.toLowerCase().replaceAll('\\', '/').split('/');
  return parts.some((part) => {
    const name = part.replace(/[. ]+$/, '');
    if (['.ssh', '.aws', '.azure', '.kube', '.gnupg'].includes(name))
      return true;
    if (name === '.env.example') return false;
    if (/^\.env(?:[._-]|$)/.test(name) || name === '.envrc') return true;
    return SENSITIVE_FILE_PATTERNS.some((pattern) =>
      pattern.startsWith('.') ? name.endsWith(pattern) : name === pattern
    );
  });
}

function ensureNoOptionInjection(value, field) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('-') ||
    value.includes('\0')
  ) {
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

export function resolveContainedPath(rootPath, pathText) {
  ensureNoOptionInjection(pathText, 'path');
  const normalized = pathText.replaceAll('\\', '/');
  if (
    (process.platform !== 'win32' &&
      win32.parse(normalized).root.includes(':')) ||
    normalized.startsWith('//') ||
    normalized.replace(/^[a-z]:/i, '').includes(':')
  ) {
    throw new HarnessError('E_PATH_OUT_OF_ROOT', 'Path escapes allowed root.');
  }
  const absolute = resolve(rootPath, normalized);
  if (escapesRoot(relative(rootPath, absolute))) {
    throw new HarnessError('E_PATH_OUT_OF_ROOT', 'Path escapes allowed root.', {
      pathText,
    });
  }
  return absolute;
}

function validateLimit(value, field) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new HarnessError('E_CAPABILITY_INPUT_INVALID', `Invalid ${field}.`, {
      field,
    });
  }
}

export function withCollectionMetadata(
  items,
  { truncated = false, omittedCount = 0 } = {}
) {
  Object.defineProperties(items, {
    truncated: { value: Boolean(truncated), enumerable: false },
    omittedCount: { value: omittedCount, enumerable: false },
  });
  return items;
}

export function createCapabilityRegistry({ rootPath, collector }) {
  const canonicalRoot = resolve(rootPath);

  function assertInRoot(pathText) {
    return resolveContainedPath(canonicalRoot, pathText);
  }

  function allowedResult(pathText) {
    try {
      assertInRoot(pathText);
      return !isLikelySensitivePath(pathText);
    } catch (error) {
      if (
        ['E_PATH_OUT_OF_ROOT', 'E_CAPABILITY_INPUT_INVALID'].includes(
          error.code
        )
      )
        return false;
      throw error;
    }
  }

  function filterResults(results, predicate) {
    const filtered = results.filter(predicate);
    return withCollectionMetadata(filtered, {
      truncated: results.truncated,
      omittedCount:
        (results.omittedCount ?? 0) + results.length - filtered.length,
    });
  }

  const capabilities = {
    'filesystem.findFiles': {
      name: 'filesystem.findFiles',
      riskLevel: 'low',
      timeoutMs: 15_000,
      inputContract: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            minimum: 1,
            description:
              'Maximum number of discovered files, capped by harness limits.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      invoke: async ({ signal, limit }) => {
        validateLimit(limit, 'limit');
        return filterResults(
          await collector.findFiles({ signal, limit }),
          allowedResult
        );
      },
    },
    'filesystem.readTextFile': {
      name: 'filesystem.readTextFile',
      riskLevel: 'low',
      timeoutMs: 5_000,
      inputContract: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            minLength: 1,
            description: 'File path within the approved repository root.',
          },
          maxBytes: {
            type: 'integer',
            minimum: 1,
            description: 'Maximum bytes to read, capped by harness limits.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      invoke: async ({ path, signal, maxBytes }) => {
        validateLimit(maxBytes, 'maxBytes');
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
        properties: {
          pattern: {
            type: 'string',
            minLength: 1,
            description:
              'Literal text to search for; not a regular expression or option.',
          },
          maxMatches: {
            type: 'integer',
            minimum: 1,
            description: 'Maximum matches to return, capped by harness limits.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
      invoke: async ({ pattern, signal, maxMatches }) => {
        validateLimit(maxMatches, 'maxMatches');
        ensureNoOptionInjection(pattern, 'pattern');
        const matches = await collector.searchText({
          pattern,
          signal,
          maxMatches,
        });
        return filterResults(matches, (match) =>
          allowedResult(match.relativePath)
        );
      },
    },
  };

  return {
    get(name) {
      if (!Object.hasOwn(capabilities, name)) {
        throw new HarnessError(
          'E_CAPABILITY_NOT_ALLOWED',
          'Capability not approved.',
          { name }
        );
      }
      return capabilities[name];
    },
  };
}
