import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdmissionController } from '../src/admission/controller.js';

test('saturates queue and supports queued cancellation', async () => {
  const admission = createAdmissionController({ maxActive: 1, maxQueued: 1 });
  await admission.acquire();

  const queuedAbort = new AbortController();
  const queued = admission.acquire(queuedAbort.signal);
  await Promise.resolve();

  await assert.rejects(() => admission.acquire(), { code: 'E_ADMISSION_SATURATED' });

  queuedAbort.abort();
  await assert.rejects(() => queued, { code: 'E_ABORTED' });

  admission.release();
  assert.equal(admission.stats().active, 0);
});
