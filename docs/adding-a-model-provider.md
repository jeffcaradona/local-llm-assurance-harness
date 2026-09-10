# Adding a model provider

1. Create provider module under `src/model/` with a `complete({ systemPrompt, userPrompt, signal })` contract.
2. Enforce request timeout, transport bounds, response byte limits, and redirect policy.
3. Normalize transport/HTTP/parse errors to stable `HarnessError` codes.
4. Return parsed JSON review payload only; do not auto-repair malformed model output.
5. Always run local schema validation and evidence-reference checks in orchestration.
6. Add provider tests with controlled local HTTP fixtures for timeout, malformed output, and over-limit responses.

Providers may optimize prompt options, but policy enforcement remains in harness code.
