import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntimeConfig, validateRuntimeConfig } from '../src/config.js';
import { HarnessError } from '../src/errors.js';

test('accepts local model endpoint', () => {
  const config = resolveRuntimeConfig({
    HARNESS_MODEL_BASE_URL: 'http://127.0.0.1:8080/v1',
    HARNESS_MODEL_ID: 'x',
  });
  assert.doesNotThrow(() => validateRuntimeConfig(config));
});

test('model timeout defaults to three minutes when unset or blank', () => {
  for (const value of [undefined, '', '  ']) {
    const config = validateRuntimeConfig(
      resolveRuntimeConfig({ HARNESS_MODEL_TIMEOUT_MS: value })
    );
    assert.equal(config.model.timeoutMs, 180_000);
    assert.equal(config.limits.requestTimeoutMs, 180_000);
  }
});

test('model timeout can be increased for cold loads', () => {
  const config = validateRuntimeConfig(
    resolveRuntimeConfig({ HARNESS_MODEL_TIMEOUT_MS: '600000' })
  );
  assert.equal(config.model.timeoutMs, 600_000);
  assert.equal(config.limits.requestTimeoutMs, 600_000);
});

test('model max tokens is optional or a positive integer', () => {
  assert.equal(
    validateRuntimeConfig(resolveRuntimeConfig({})).model.maxTokens,
    undefined
  );
  assert.equal(
    validateRuntimeConfig(
      resolveRuntimeConfig({ HARNESS_MODEL_MAX_TOKENS: '8192' })
    ).model.maxTokens,
    8192
  );

  for (const value of [
    '0',
    '-1',
    '1.5',
    'abc',
    'Infinity',
    '9007199254740992',
  ]) {
    assert.throws(
      () =>
        validateRuntimeConfig(
          resolveRuntimeConfig({ HARNESS_MODEL_MAX_TOKENS: value })
        ),
      { code: 'E_CONFIG_INVALID' }
    );
  }
});

test('rejects invalid model timeouts including values that overflow Node timers', () => {
  for (const value of ['0', '-1', '1.5', 'abc', 'Infinity', '2147483648']) {
    assert.throws(
      () =>
        validateRuntimeConfig(
          resolveRuntimeConfig({ HARNESS_MODEL_TIMEOUT_MS: value })
        ),
      { code: 'E_CONFIG_INVALID' }
    );
  }
});

test('model temperature defaults to 0.2 and accepts overrides', () => {
  for (const value of [undefined, '', '  ']) {
    assert.equal(
      validateRuntimeConfig(
        resolveRuntimeConfig({ HARNESS_MODEL_TEMPERATURE: value })
      ).model.temperature,
      0.2
    );
  }
  assert.equal(
    validateRuntimeConfig(
      resolveRuntimeConfig({ HARNESS_MODEL_TEMPERATURE: '0' })
    ).model.temperature,
    0
  );
  assert.equal(
    validateRuntimeConfig(
      resolveRuntimeConfig({ HARNESS_MODEL_TEMPERATURE: '0.7' })
    ).model.temperature,
    0.7
  );
});

test('rejects invalid model temperatures', () => {
  for (const value of ['-0.1', '2.1', 'abc', 'Infinity']) {
    assert.throws(
      () =>
        validateRuntimeConfig(
          resolveRuntimeConfig({ HARNESS_MODEL_TEMPERATURE: value })
        ),
      { code: 'E_CONFIG_INVALID' }
    );
  }
});

test('model reasoning effort is unset by default and accepts known levels', () => {
  for (const value of [undefined, '', '  ']) {
    assert.equal(
      validateRuntimeConfig(
        resolveRuntimeConfig({ HARNESS_MODEL_REASONING_EFFORT: value })
      ).model.reasoningEffort,
      undefined
    );
  }
  for (const value of ['none', 'low', 'medium', 'high']) {
    assert.equal(
      validateRuntimeConfig(
        resolveRuntimeConfig({ HARNESS_MODEL_REASONING_EFFORT: value })
      ).model.reasoningEffort,
      value
    );
  }
});

test('rejects unknown model reasoning effort', () => {
  for (const value of ['off', 'NONE', 'max']) {
    assert.throws(
      () =>
        validateRuntimeConfig(
          resolveRuntimeConfig({ HARNESS_MODEL_REASONING_EFFORT: value })
        ),
      { code: 'E_CONFIG_INVALID' }
    );
  }
});

test('rejects malformed model endpoint URLs with a stable configuration error', () => {
  assert.throws(
    () =>
      validateRuntimeConfig(
        resolveRuntimeConfig({ HARNESS_MODEL_BASE_URL: 'not a url' })
      ),
    {
      code: 'E_CONFIG_INVALID',
    }
  );
});

test('rejects non-local endpoint unless explicitly allowed', () => {
  const config = resolveRuntimeConfig({
    HARNESS_MODEL_BASE_URL: 'https://example.com/v1',
    HARNESS_MODEL_ID: 'x',
  });
  assert.throws(
    () => validateRuntimeConfig(config),
    (error) =>
      error instanceof HarnessError &&
      error.code === 'E_REMOTE_ENDPOINT_FORBIDDEN'
  );
});
