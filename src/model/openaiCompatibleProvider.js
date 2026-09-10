import { HarnessError } from '../errors.js';

async function readBodyBounded(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let total = 0;
  const chunks = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new HarnessError('E_MODEL_RESPONSE_TOO_LARGE', 'Model response exceeded byte limit.', { maxBytes });
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString('utf8');
}

export function createOpenAICompatibleProvider(config) {
  const endpoint = new URL('/chat/completions', config.baseUrl).toString();

  return {
    async complete({ systemPrompt, userPrompt, signal }) {
      const inputChars = systemPrompt.length + userPrompt.length;
      if (inputChars > config.maxPromptChars) {
        throw new HarnessError('E_INPUT_BUDGET_EXCEEDED', 'Prompt exceeded configured character budget.', {
          inputChars,
          max: config.maxPromptChars
        });
      }

      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), config.timeoutMs);
      const combined = AbortSignal.any([timeoutController.signal, signal].filter(Boolean));
      const headers = { 'content-type': 'application/json' };
      if (config.apiKey) {
        headers.authorization = 'Bearer ' + config.apiKey;
      }

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'manual',
          signal: combined,
          headers,
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
            response_format: { type: 'json_object' }
          })
        });

        if (response.status >= 300 && response.status < 400) {
          throw new HarnessError('E_MODEL_REDIRECT_FORBIDDEN', 'Model endpoint redirect was rejected.', { status: response.status });
        }

        const bodyText = await readBodyBounded(response, config.maxResponseBytes);

        if (!response.ok) {
          throw new HarnessError('E_MODEL_HTTP_ERROR', 'Model endpoint returned failure status.', {
            status: response.status,
            bodyPreview: bodyText.slice(0, 500)
          });
        }

        let parsed;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          throw new HarnessError('E_MODEL_RESPONSE_PARSE', 'Model response was not valid JSON.');
        }

        const content = parsed?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new HarnessError('E_MODEL_RESPONSE_SHAPE', 'Model response omitted text content.');
        }

        try {
          return JSON.parse(content);
        } catch {
          throw new HarnessError('E_MODEL_OUTPUT_NOT_JSON', 'Model output content was not JSON.');
        }
      } catch (error) {
        if (error instanceof HarnessError) throw error;
        if (timeoutController.signal.aborted) {
          throw new HarnessError('E_MODEL_TIMEOUT', 'Model request timed out.');
        }
        if (error?.name === 'AbortError') {
          throw new HarnessError('E_ABORTED', 'Model request aborted.');
        }
        throw new HarnessError('E_MODEL_TRANSPORT', 'Model transport failed.', { cause: error?.message });
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
