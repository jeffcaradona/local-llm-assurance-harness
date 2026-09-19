# Adding a model provider

1. Create provider module under `src/model/` with a `complete({ systemPrompt, userPrompt, responseSchema, signal })` contract. `responseSchema` is optional: when present, request schema-constrained output if the server supports it; when absent, fall back to plain JSON mode.
2. Enforce request timeout, transport bounds, response byte limits, and redirect policy.
3. Normalize transport/HTTP/parse errors to stable `HarnessError` codes. A token-limit stop (for example `finish_reason: "length"`) must surface as `E_MODEL_OUTPUT_TRUNCATED`, not as a JSON parse failure; thinking models can spend the whole output budget on hidden reasoning and return empty content.
4. Return the parsed JSON payload only: a review for single-pass mode or an action envelope for investigation. Do not auto-repair malformed model output. This includes Markdown code fences: fenced content is rejected with `E_MODEL_OUTPUT_NOT_JSON`.
5. Always run local schema validation and evidence-reference checks in orchestration.
6. Add provider tests with controlled local HTTP fixtures for timeout, malformed output, and over-limit responses.

Providers may optimize prompt options, but policy enforcement remains in harness code.

## Investigation requests

The same configured provider is called sequentially in opt-in investigation mode. Each `complete` call receives a freshly compiled bounded context and its `responseSchema`: either the investigation action schema or the narrower final-only schema. Do not hard-code the review schema or unwrap `action.review` in the provider.

Return exactly one JSON action. The harness validates it locally, dispatches any approved tool itself, and applies the existing review schema and evidence-reference checks to the final review. A provider must not execute tools, translate arbitrary model text into capabilities, delegate to other models, start background jobs, or retry malformed actions behind the orchestrator's accounting.

The default investigation allows 8 model calls, 6 model-requested tools, and 600,000 ms overall after admission. The final allowed model call is reserved for a final-only response. `HARNESS_MODEL_MAX_TOKENS` and `HARNESS_MODEL_TIMEOUT_MS` still apply per response/request, not to the sum of calls. Honor the supplied abort signal as well as the provider timeout, release HTTP resources, and preserve stable errors. Client-side HTTP cancellation does not prove the server stopped inference.

Treat all repository evidence, navigation, and prior actions as untrusted. Keep original retained excerpts intact; do not silently truncate, summarize away, or promote them into trusted policy. Respect local response-byte bounds even if the endpoint claims schema-constrained output.

Test normal tool/final action transport, final-only schemas, cancellation, token-limit stops, and malformed payloads using the existing local HTTP fixtures. Server support for `response_format: json_schema` is not a substitute for local validation. Replay uses recorded actions without calling this provider: it verifies recorded execution, not deterministic model behavior or authenticity.
