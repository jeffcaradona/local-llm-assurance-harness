import { HarnessError } from '../errors.js';

export function createAdmissionController({ maxActive, maxQueued }) {
  let active = 0;
  let accepting = true;
  const queue = [];

  const runNext = () => {
    if (active >= maxActive || !queue.length) return;
    const item = queue.shift();
    if (item.signal?.aborted) {
      item.reject(new HarnessError('E_ABORTED', 'Queued request aborted.'));
      runNext();
      return;
    }
    active += 1;
    item.resolve();
  };

  return {
    stats() {
      return { active, queued: queue.length, accepting };
    },
    close() {
      accepting = false;
      while (queue.length) {
        queue
          .shift()
          .reject(
            new HarnessError(
              'E_SHUTDOWN_REJECTED',
              'Request rejected during shutdown.'
            )
          );
      }
    },
    async acquire(signal) {
      if (!accepting) {
        throw new HarnessError(
          'E_SHUTDOWN_REJECTED',
          'Harness is shutting down.'
        );
      }
      if (signal?.aborted) {
        throw new HarnessError('E_ABORTED', 'Request was already aborted.');
      }
      if (active < maxActive) {
        active += 1;
        return;
      }
      if (queue.length >= maxQueued) {
        throw new HarnessError(
          'E_ADMISSION_SATURATED',
          'Admission queue is full.'
        );
      }

      await new Promise((resolve, reject) => {
        const queuedItem = { signal };
        const onAbort = () => {
          const index = queue.indexOf(queuedItem);
          if (index >= 0) queue.splice(index, 1);
          reject(new HarnessError('E_ABORTED', 'Queued request aborted.'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        Object.assign(queuedItem, {
          resolve: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
          reject: (error) => {
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        });
        queue.push(queuedItem);
      });
    },
    release() {
      if (active === 0) {
        throw new HarnessError(
          'E_ADMISSION_RELEASE_INVALID',
          'Cannot release admission when no request is active.'
        );
      }
      active -= 1;
      runNext();
    },
  };
}
