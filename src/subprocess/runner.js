import { spawn as nodeSpawn } from 'node:child_process';
import { HarnessError } from '../errors.js';

function limitBuffer(buffer, chunk, maxBytes) {
  const next = Buffer.concat([buffer, chunk]);
  return next.length > maxBytes ? next.subarray(0, maxBytes) : next;
}

export function createSubprocessRunner({ spawn = nodeSpawn } = {}) {
  return {
    async run(command, args, options = {}) {
      const {
        cwd,
        signal,
        timeoutMs = 15_000,
        stdoutMaxBytes = 2 * 1024 * 1024,
        stderrMaxBytes = 256 * 1024,
        env = {}
      } = options;

      if (signal?.aborted) {
        throw new HarnessError('E_ABORTED', 'Operation aborted before subprocess start.');
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let stdoutTruncated = false;
        let stderrTruncated = false;

        const child = spawn(command, args, {
          cwd,
          shell: false,
          env: { ...process.env, ...env },
          stdio: ['ignore', 'pipe', 'pipe']
        });

        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          child.stdout?.removeAllListeners();
          child.stderr?.removeAllListeners();
          child.removeAllListeners();
          fn(value);
        };

        const stop = () => {
          if (process.platform === 'win32') {
            child.kill();
          } else {
            child.kill('SIGTERM');
          }
        };

        const onAbort = () => {
          stop();
          settle(reject, new HarnessError('E_ABORTED', 'Subprocess aborted.'));
        };

        const timer = setTimeout(() => {
          stop();
          settle(reject, new HarnessError('E_SUBPROCESS_TIMEOUT', 'Subprocess timeout exceeded.', { command }));
        }, timeoutMs);

        child.on('error', (error) => {
          if (error.code === 'ENOENT') {
            settle(reject, new HarnessError('E_EXECUTABLE_NOT_FOUND', 'Required executable is unavailable.', { command }));
            return;
          }
          settle(reject, new HarnessError('E_SUBPROCESS_SPAWN', 'Subprocess failed to start.', { command, cause: error.message }));
        });

        child.stdout?.on('data', (chunk) => {
          const next = limitBuffer(stdout, chunk, stdoutMaxBytes);
          if (next.length < stdout.length + chunk.length) stdoutTruncated = true;
          stdout = next;
        });

        child.stderr?.on('data', (chunk) => {
          const next = limitBuffer(stderr, chunk, stderrMaxBytes);
          if (next.length < stderr.length + chunk.length) stderrTruncated = true;
          stderr = next;
        });

        child.on('close', (exitCode, termSignal) => {
          settle(resolve, {
            exitCode,
            termSignal,
            stdout: stdout.toString('utf8'),
            stderr: stderr.toString('utf8'),
            stdoutTruncated,
            stderrTruncated
          });
        });

        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  };
}
