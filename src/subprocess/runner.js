import { spawn as nodeSpawn } from 'node:child_process';
import { HarnessError } from '../errors.js';

function limitBuffer(buffer, chunk, maxBytes) {
  const next = Buffer.concat([buffer, chunk]);
  return next.length > maxBytes ? next.subarray(0, maxBytes) : next;
}

export function createSubprocessRunner({
  spawn = nodeSpawn,
  platform = process.platform,
  terminationGraceMs = 500,
} = {}) {
  return {
    async run(command, args, options = {}) {
      const {
        cwd,
        signal,
        timeoutMs = 15_000,
        stdoutMaxBytes = 2 * 1024 * 1024,
        stderrMaxBytes = 256 * 1024,
        env = {},
      } = options;

      if (signal?.aborted) {
        throw new HarnessError(
          'E_ABORTED',
          'Operation aborted before subprocess start.'
        );
      }

      return new Promise((resolve, reject) => {
        let callerSettled = false;
        let observingChild = true;
        let terminationRequested = false;
        let terminationReason;
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timeoutTimer;
        let escalationTimer;

        const baseEnv = Object.fromEntries(
          ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT']
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]])
        );
        const child = spawn(command, args, {
          cwd,
          shell: false,
          env: { ...baseEnv, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const removeOperationListeners = () => {
          clearTimeout(timeoutTimer);
          signal?.removeEventListener('abort', onAbort);
          child.stdout?.off('data', onStdout);
          child.stderr?.off('data', onStderr);
        };

        const stopObservingChild = () => {
          if (!observingChild) return;
          observingChild = false;
          clearTimeout(escalationTimer);
          child.off('error', onError);
          child.off('close', onClose);
        };

        const settleCaller = (fn, value) => {
          if (callerSettled) return;
          callerSettled = true;
          removeOperationListeners();
          fn(value);
        };

        const requestTermination = (reason) => {
          if (terminationRequested || !observingChild) return;
          terminationRequested = true;
          terminationReason = reason;
          removeOperationListeners();

          try {
            child.kill(platform === 'win32' ? undefined : 'SIGTERM');
          } catch {
            // Termination failures do not replace the operation's stable error.
          }

          if (!observingChild) return;
          escalationTimer = setTimeout(() => {
            escalationTimer = undefined;
            if (!observingChild) return;
            try {
              // POSIX SIGKILL is stronger than SIGTERM. Node maps supported
              // signals to direct-process termination on Windows, so this is
              // the strongest available retry there. Neither path covers descendants.
              child.kill('SIGKILL');
            } catch {
              // Cleanup cannot replace the original abort/timeout failure.
            }
            settleCaller(reject, terminationReason);
            stopObservingChild();
          }, terminationGraceMs);
        };

        const onAbort = () => {
          requestTermination(
            new HarnessError('E_ABORTED', 'Subprocess aborted.')
          );
        };

        const onError = (error) => {
          if (terminationRequested) return;
          settleCaller(
            reject,
            error.code === 'ENOENT'
              ? new HarnessError(
                  'E_EXECUTABLE_NOT_FOUND',
                  'Required executable is unavailable.',
                  { command }
                )
              : new HarnessError(
                  'E_SUBPROCESS_SPAWN',
                  'Subprocess failed to start.',
                  { command, cause: error.message }
                )
          );
          stopObservingChild();
        };

        const onStdout = (chunk) => {
          const next = limitBuffer(stdout, chunk, stdoutMaxBytes);
          if (next.length < stdout.length + chunk.length)
            stdoutTruncated = true;
          stdout = next;
        };

        const onStderr = (chunk) => {
          const next = limitBuffer(stderr, chunk, stderrMaxBytes);
          if (next.length < stderr.length + chunk.length)
            stderrTruncated = true;
          stderr = next;
        };

        const onClose = (exitCode, termSignal) => {
          if (terminationRequested) {
            settleCaller(reject, terminationReason);
          } else {
            settleCaller(resolve, {
              exitCode,
              termSignal,
              stdout: stdout.toString('utf8'),
              stderr: stderr.toString('utf8'),
              stdoutTruncated,
              stderrTruncated,
            });
          }
          stopObservingChild();
        };

        child.on('error', onError);
        child.stdout?.on('data', onStdout);
        child.stderr?.on('data', onStderr);
        child.on('close', onClose);

        timeoutTimer = setTimeout(() => {
          requestTermination(
            new HarnessError(
              'E_SUBPROCESS_TIMEOUT',
              'Subprocess timeout exceeded.',
              { command }
            )
          );
        }, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
  };
}
