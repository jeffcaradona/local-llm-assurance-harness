import { HarnessError } from '../errors.js';

export function createLifecycleManager({ admission, shutdownGraceMs, shutdownDeadlineMs }) {
  let shuttingDown = false;
  const activeControllers = new Set();

  return {
    createRequestScope() {
      if (shuttingDown) {
        throw new HarnessError('E_SHUTDOWN_REJECTED', 'Harness is shutting down.');
      }
      const controller = new AbortController();
      activeControllers.add(controller);
      return {
        signal: controller.signal,
        abort: () => controller.abort(),
        done: () => activeControllers.delete(controller)
      };
    },
    async shutdown() {
      shuttingDown = true;
      admission.close();

      const graceEnd = Date.now() + shutdownGraceMs;
      while (admission.stats().active > 0 && Date.now() < graceEnd) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      for (const controller of activeControllers) {
        controller.abort();
      }

      const deadline = Date.now() + shutdownDeadlineMs;
      while (admission.stats().active > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  };
}
