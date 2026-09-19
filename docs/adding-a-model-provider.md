# Adding a model provider

1. Create provider module under `src/model/` with a `complete({ systemPrompt, userPrompt, responseSchema, signal })` contract. `responseSchema` is optional: when present, request schema-constrained output if the server supports it; when absent, fall back to plain JSON mode.
2. Enforce request timeout, transport bounds, response byte limits, and redirect policy.
3. Normalize transport/HTTP/parse errors to stable `HarnessError` codes. A token-limit stop (for example `finish_reason: "length"`) must surface as `E_MODEL_OUTPUT_TRUNCATED`, not as a JSON parse failure; thinking models can spend the whole output budget on hidden reasoning and return empty content.
4. Return parsed JSON review payload only; do not auto-repair malformed model output. This includes Markdown code fences: fenced content is rejected with `E_MODEL_OUTPUT_NOT_JSON`.
5. Always run local schema validation and evidence-reference checks in orchestration.
6. Add provider tests with controlled local HTTP fixtures for timeout, malformed output, and over-limit responses.

Providers may optimize prompt options, but policy enforcement remains in harness code.
