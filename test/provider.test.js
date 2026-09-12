import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOpenAICompatibleProvider } from '../src/model/openaiCompatibleProvider.js';
import { compilePromptContext } from '../src/context/compiler.js';
import { reviewSchema } from '../src/review/schema.js';
import { validateReviewPayload } from '../src/review/validator.js';

function withServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, () => resolve(server));
    server.on('error', reject);
  });
}

test('provider rejects oversized response body', async () => {
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
      maxResponseBytes: 100
    });
    await assert.rejects(() => provider.complete({ systemPrompt: 's', userPrompt: 'u' }), { code: 'E_MODEL_RESPONSE_TOO_LARGE' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schemaVersion: '1.0.0', summary: 'ok', decision: 'no_findings_in_supplied_evidence', observations: [], inferences: [], findings: [], limitations: { notes: [], omittedEvidenceIds: [] } }) } }] })
    );
  });
  try {
    const port = server.address().port;
    const provider = createOpenAICompatibleProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'm',
      maxPromptChars: 10_000,
      timeoutMs: 1000,
      maxResponseBytes: 10_000
    });

    const context = await compilePromptContext({ request: 'Review concurrency bounds.', evidence: [], maxChars: 10_000 });
    const out = await provider.complete(context);
    validateReviewPayload(out);
    assert.equal(out.summary, 'ok');
    assert.equal(seenPath, '/v1/chat/completions');
    assert.deepEqual(seenBody.response_format, { type: 'json_object' });
    assert.deepEqual(JSON.parse(seenBody.messages[0].content.split('Review response JSON Schema:\n')[1]), reviewSchema);
    assert.equal(seenBody.messages[1].content, context.userPrompt);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
