import { resolve } from 'node:path';
import { HarnessError } from './errors.js';

const MB = 1024 * 1024;

export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 40,
  maxSearchMatches: 200,
  maxFileBytes: 48 * 1024,
  maxEvidenceBytes: 400 * 1024,
  maxPromptChars: 240_000,
  maxResponseBytes: 512 * 1024,
  subprocessStdoutBytes: 2 * MB,
  subprocessStderrBytes: 256 * 1024,
  subprocessTimeoutMs: 15_000,
  requestTimeoutMs: 180_000,
  activeRequests: 2,
  queuedRequests: 4,
  shutdownGraceMs: 1_500,
  shutdownDeadlineMs: 3_000
});

export function resolveRuntimeConfig(env = process.env) {
  const requestTimeoutMs = env.HARNESS_MODEL_TIMEOUT_MS?.trim()
    ? Number(env.HARNESS_MODEL_TIMEOUT_MS)
    : DEFAULT_LIMITS.requestTimeoutMs;
  const outputDir = env.HARNESS_OUTPUT_DIR
    ? resolve(env.HARNESS_OUTPUT_DIR)
    : resolve(process.cwd(), '..', 'harness-runs');

  return {
    model: {
      baseUrl: env.HARNESS_MODEL_BASE_URL ?? 'http://127.0.0.1:11434/v1',
      model: env.HARNESS_MODEL_ID ?? 'local-model',
      apiKey: env.HARNESS_MODEL_API_KEY,
      allowNonLocalEndpoint: env.HARNESS_ALLOW_NON_LOCAL_ENDPOINT === 'true',
      maxResponseBytes: DEFAULT_LIMITS.maxResponseBytes,
      timeoutMs: requestTimeoutMs,
      maxPromptChars: DEFAULT_LIMITS.maxPromptChars,
      maxTokens: env.HARNESS_MODEL_MAX_TOKENS ? Number(env.HARNESS_MODEL_MAX_TOKENS) : undefined
    },
    review: {
      outputDir,
      instructionFiles: []
    },
    limits: { ...DEFAULT_LIMITS, requestTimeoutMs }
  };
}

export function validateRuntimeConfig(config) {
  if (!config?.model?.baseUrl || !config.model.model) {
    throw new HarnessError('E_CONFIG_INVALID', 'Model endpoint and model id are required.');
  }
  if (!Number.isInteger(config.model.timeoutMs) || config.model.timeoutMs < 1 || config.model.timeoutMs > 2_147_483_647) {
    throw new HarnessError('E_CONFIG_INVALID', 'Model timeout must be an integer between 1 and 2147483647 milliseconds.');
  }
  const url = new URL(config.model.baseUrl);
  const host = (url.hostname || '').toLowerCase();
  if (!config.model.allowNonLocalEndpoint && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new HarnessError('E_REMOTE_ENDPOINT_FORBIDDEN', 'Non-local model endpoint requires explicit opt-in.', {
      host
    });
  }
  return config;
}
