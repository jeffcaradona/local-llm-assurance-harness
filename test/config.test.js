import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntimeConfig, validateRuntimeConfig } from '../src/config.js';
import { HarnessError } from '../src/errors.js';

test('accepts local model endpoint', () => {
  const config = resolveRuntimeConfig({ HARNESS_MODEL_BASE_URL: 'http://127.0.0.1:8080/v1', HARNESS_MODEL_ID: 'x' });
  assert.doesNotThrow(() => validateRuntimeConfig(config));
});

test('model timeout defaults to three minutes when unset or blank', () => {
  for (const value of [undefined, '', '  ']) {
    const config = validateRuntimeConfig(resolveRuntimeConfig({ HARNESS_MODEL_TIMEOUT_MS: value }));
    assert.equal(config.model.timeoutMs, 180_000);
    assert.equal(config.limits.requestTimeoutMs, 180_000);
  }
});

test('model timeout can be increased for cold loads', () => {
  const config = validateRuntimeConfig(resolveRuntimeConfig({ HARNESS_MODEL_TIMEOUT_MS: '600000' }));
  assert.equal(config.model.timeoutMs, 600_000);
  assert.equal(config.limits.requestTimeoutMs, 600_000);
});

test('rejects invalid model timeouts including values that overflow Node timers', () => {
  for (const value of ['0', '-1', '1.5', 'abc', 'Infinity', '2147483648']) {
    assert.throws(
      () => validateRuntimeConfig(resolveRuntimeConfig({ HARNESS_MODEL_TIMEOUT_MS: value })),
      { code: 'E_CONFIG_INVALID' }
    );
  }
});

test('rejects non-local endpoint unless explicitly allowed', () => {
  const config = resolveRuntimeConfig({ HARNESS_MODEL_BASE_URL: 'https://example.com/v1', HARNESS_MODEL_ID: 'x' });
  assert.throws(() => validateRuntimeConfig(config), (error) => error instanceof HarnessError && error.code === 'E_REMOTE_ENDPOINT_FORBIDDEN');
});
