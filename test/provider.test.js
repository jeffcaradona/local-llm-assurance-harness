import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOpenAICompatibleProvider } from '../src/model/openaiCompatibleProvider.js';
import { compilePromptContext } from '../src/context/compiler.js';
import { modelReviewSchema } from '../src/review/schema.js';
import { validateReviewPayload } from '../src/review/validator.js';

function withServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, () => resolve(server));
    server.on('error', reject);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function providerFor(server, overrides = {}) {
  return createOpenAICompatibleProvider({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'm',
    maxPromptChars: 1000,
    timeoutMs: 1000,
    maxResponseBytes: 10_000,
    ...overrides,
  });
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test('provider rejects oversized successful response body', async () => {
  const server = await withServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('x'.repeat(1024));
  });
  try {
    const port = server.address().port;
    const provider = createOpenAICompatibleProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'm',
      maxPromptChars: 1000,
      timeoutMs: 1000,
      maxResponseBytes: 100,
    });
    await assert.rejects(
      () => provider.complete({ systemPrompt: 's', userPrompt: 'u' }),
      { code: 'E_MODEL_RESPONSE_TOO_LARGE' }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('provider rejects redirects without following them', async () => {
  let redirectedRequest = false;
  const server = await withServer((req, res) => {
    if (req.url === '/redirected') {
      redirectedRequest = true;
      res.end();
      return;
    }
    res.writeHead(302, { location: '/redirected' });
    res.end();
  });
  try {
    await assert.rejects(
      () =>
        providerFor(server).complete({
          systemPrompt: 's',
          userPrompt: 'u',
        }),
      { code: 'E_MODEL_REDIRECT_FORBIDDEN' }
    );
    assert.equal(redirectedRequest, false);
  } finally {
    await closeServer(server);
  }
});

test('provider maps its request deadline to model timeout', async () => {
  const received = deferred();
  const server = await withServer((_req, _res) => {
    received.resolve();
  });
  try {
    const pending = providerFor(server, { timeoutMs: 25 }).complete({
      systemPrompt: 's',
      userPrompt: 'u',
    });
    await received.promise;
    await assert.rejects(pending, { code: 'E_MODEL_TIMEOUT' });
  } finally {
    await closeServer(server);
  }
});

test('provider preserves caller cancellation separately from timeout', async () => {
  const received = deferred();
  const server = await withServer((_req, _res) => {
    received.resolve();
  });
  const controller = new AbortController();
  try {
    const pending = providerFor(server, { timeoutMs: 10_000 }).complete({
      systemPrompt: 's',
      userPrompt: 'u',
      signal: controller.signal,
    });
    await received.promise;
    controller.abort();
    await assert.rejects(pending, { code: 'E_ABORTED' });
  } finally {
    await closeServer(server);
  }
});

test('provider maps malformed outer HTTP JSON to response parse error', async () => {
  const server = await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{not-json');
  });
  try {
    await assert.rejects(
      () =>
        providerFor(server).complete({
          systemPrompt: 's',
          userPrompt: 'u',
        }),
      { code: 'E_MODEL_RESPONSE_PARSE' }
    );
  } finally {
    await closeServer(server);
  }
});

test('provider maps non-success responses to HTTP errors with a preview', async () => {
  const server = await withServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'text/plain' });
    res.end('slow down');
  });
  try {
    await assert.rejects(
      () =>
        providerFor(server).complete({
          systemPrompt: 's',
          userPrompt: 'u',
        }),
      {
        code: 'E_MODEL_HTTP_ERROR',
        details: { status: 429, bodyPreview: 'slow down' },
      }
    );
  } finally {
    await closeServer(server);
  }
});

test('oversized non-success response remains a bounded HTTP error', async () => {
  const server = await withServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('x'.repeat(10_000));
  });
  try {
    await assert.rejects(
      () =>
        providerFor(server, { maxResponseBytes: 100 }).complete({
          systemPrompt: 's',
          userPrompt: 'u',
        }),
      (error) => {
        assert.equal(error.code, 'E_MODEL_HTTP_ERROR');
        assert.equal(error.details.status, 500);
        assert.equal(Buffer.byteLength(error.details.bodyPreview), 500);
        return true;
      }
    );
  } finally {
    await closeServer(server);
  }
});

test('provider parses OpenAI-compatible JSON content', async () => {
  let seenPath = '';
  let seenBody;
  const server = await withServer(async (req, res) => {
    seenPath = req.url;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                schemaVersion: '1.0.0',
                summary: 'ok',
                decision: 'no_findings_in_supplied_evidence',
                observations: [],
                inferences: [],
                findings: [],
                limitations: { notes: [], omittedEvidenceIds: [] },
              }),
            },
          },
        ],
      })
    );
  });
  try {
    const port = server.address().port;
    const provider = createOpenAICompatibleProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'm',
      maxPromptChars: 10_000,
      timeoutMs: 1000,
      maxResponseBytes: 10_000,
    });

    const context = await compilePromptContext({
      request: 'Review concurrency bounds.',
      evidence: [],
      maxChars: 10_000,
    });
    const out = await provider.complete(context);
    validateReviewPayload(out);
    assert.equal(out.summary, 'ok');
    assert.equal(seenPath, '/v1/chat/completions');
    assert.equal(seenBody.response_format.type, 'json_schema');
    assert.deepEqual(
      JSON.parse(
        seenBody.messages[0].content.split('Review response JSON Schema:\n')[1]
      ),
      modelReviewSchema
    );
    assert.equal(seenBody.messages[1].content, context.userPrompt);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('provider rejects a Markdown code fence around model content instead of repairing it', async () => {
  const server = await withServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
      })
    );
  });
  try {
    const port = server.address().port;
    const provider = createOpenAICompatibleProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'm',
      maxPromptChars: 1000,
      timeoutMs: 1000,
      maxResponseBytes: 10_000,
    });

    await assert.rejects(
      () => provider.complete({ systemPrompt: 's', userPrompt: 'u' }),
      { code: 'E_MODEL_OUTPUT_NOT_JSON' }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function captureRequestBody(run) {
  let seenBody;
  const server = await withServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })
    );
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}/v1`);
    return seenBody;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('provider requests schema-constrained output and sends configured temperature', async () => {
  const body = await captureRequestBody(async (baseUrl) => {
    const provider = createOpenAICompatibleProvider({
      baseUrl,
      model: 'm',
      maxPromptChars: 1000,
      timeoutMs: 1000,
      maxResponseBytes: 10_000,
      temperature: 0.2,
      reasoningEffort: 'none',
    });
    await provider.complete({
      systemPrompt: 's',
      userPrompt: 'u',
      responseSchema: modelReviewSchema,
    });
  });

  assert.deepEqual(body.response_format, {
    type: 'json_schema',
    json_schema: { name: 'review', strict: true, schema: modelReviewSchema },
  });
  assert.equal('$id' in body.response_format.json_schema.schema, false);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.reasoning_effort, 'none');
});

test('provider reports token-limit truncation instead of a JSON parse failure', async () => {
  // Thinking models can spend the whole max_tokens budget on hidden reasoning and return empty content.
  const server = await withServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'length',
            message: { content: '', reasoning: 'x'.repeat(100) },
          },
        ],
        usage: { completion_tokens: 8192 },
      })
    );
  });
  try {
    const provider = createOpenAICompatibleProvider({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'm',
      maxPromptChars: 1000,
      timeoutMs: 1000,
      maxResponseBytes: 10_000,
      maxTokens: 8192,
    });
    await assert.rejects(
      () => provider.complete({ systemPrompt: 's', userPrompt: 'u' }),
      {
        code: 'E_MODEL_OUTPUT_TRUNCATED',
        details: { maxTokens: 8192, completionTokens: 8192, contentChars: 0 },
      }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('provider falls back to json_object and omits temperature when neither is configured', async () => {
  const body = await captureRequestBody(async (baseUrl) => {
    const provider = createOpenAICompatibleProvider({
      baseUrl,
      model: 'm',
      maxPromptChars: 1000,
      timeoutMs: 1000,
      maxResponseBytes: 10_000,
    });
    await provider.complete({ systemPrompt: 's', userPrompt: 'u' });
  });

  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal('temperature' in body, false);
  assert.equal('reasoning_effort' in body, false);
});
