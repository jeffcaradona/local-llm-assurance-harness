import { HarnessError } from '../errors.js';

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw new HarnessError(
    signal.reason?.code === 'E_INVESTIGATION_TIMEOUT'
      ? 'E_INVESTIGATION_TIMEOUT'
      : 'E_ABORTED',
    'Operation cancelled.'
  );
}

// Callers settle promptly; adapters still own cleanup of in-flight resources.
export async function withCancellation(operation, signal) {
  throwIfAborted(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        throwIfAborted(signal);
        return operation();
      }),
      aborted,
    ]);
    throwIfAborted(signal);
    return result;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
