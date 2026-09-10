import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOpenAICompatibleProvider } from '../src/model/openaiCompatibleProvider.js';

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
  const port = server.address().port;

  const provider = createOpenAICompatibleProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'm',
    maxPromptChars: 1000,
    timeoutMs: 1000,
    maxResponseBytes: 100
  });

  await assert.rejects(() => provider.complete({ systemPrompt: 's', userPrompt: 'u' }), { code: 'E_MODEL_RESPONSE_TOO_LARGE' });
  await new Promise((resolve) => server.close(resolve));
});

test('provider parses OpenAI-compatible JSON content', async () => {
  const server = await withServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schemaVersion: '1.0.0', summary: 'ok', decision: 'no_findings_in_supplied_evidence', observations: [], inferences: [], findings: [], limitations: { notes: [], omittedEvidenceIds: [] } }) } }] })
    );
  });
  const port = server.address().port;
  const provider = createOpenAICompatibleProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'm',
    maxPromptChars: 1000,
    timeoutMs: 1000,
    maxResponseBytes: 10_000
  });

  const out = await provider.complete({ systemPrompt: 's', userPrompt: 'u' });
  assert.equal(out.summary, 'ok');
  await new Promise((resolve) => server.close(resolve));
});
