import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntimeConfig, validateRuntimeConfig } from '../src/config.js';
import { HarnessError } from '../src/errors.js';

test('accepts local model endpoint', () => {
  const config = resolveRuntimeConfig({ HARNESS_MODEL_BASE_URL: 'http://127.0.0.1:8080/v1', HARNESS_MODEL_ID: 'x' });
  assert.doesNotThrow(() => validateRuntimeConfig(config));
});

test('rejects non-local endpoint unless explicitly allowed', () => {
  const config = resolveRuntimeConfig({ HARNESS_MODEL_BASE_URL: 'https://example.com/v1', HARNESS_MODEL_ID: 'x' });
  assert.throws(() => validateRuntimeConfig(config), (error) => error instanceof HarnessError && error.code === 'E_REMOTE_ENDPOINT_FORBIDDEN');
});
