# local-llm-assurance-harness

Deterministic, evidence-backed repository review harness for local OpenAI-compatible LLM endpoints.

## Purpose

This project enforces capability boundaries and provenance around repository review:

- Markdown instructions provide trusted review policy only when explicitly selected.
- Repository content remains untrusted evidence.
- The harness owns evidence collection, limits, redaction, schema validation, and audit artifacts.

Milestone one is **read-only repository review** with deterministic evidence collection and offline replay support.

## Supported runtimes

Node.js versions supported by this repository: **22.x and 24.x LTS** (`>=22.0.0 <25`).

This baseline is based on Node.js release status published at:

- https://nodejs.org/en/about/previous-releases

## Setup

```powershell
npm install
npm test
```

## Configuration

Use environment variables (see `.env.example`):

- `HARNESS_MODEL_BASE_URL` (default `http://127.0.0.1:11434/v1`)
- `HARNESS_MODEL_ID` (default `local-model`)
- `HARNESS_MODEL_API_KEY` (optional)
- `HARNESS_ALLOW_NON_LOCAL_ENDPOINT` (`true` required for non-local hosts)
- `HARNESS_OUTPUT_DIR` (must resolve outside reviewed root)
- `HARNESS_MODEL_MAX_TOKENS` (optional)
- `HARNESS_MODEL_TEMPERATURE` (default `0.2`; must be between 0 and 2)
- `HARNESS_MODEL_REASONING_EFFORT` (optional: `none`, `low`, `medium`, or `high`; sent as `reasoning_effort`. Hidden reasoning counts against `HARNESS_MODEL_MAX_TOKENS`, so thinking models can exhaust the budget before emitting the review and fail with `E_MODEL_OUTPUT_TRUNCATED`; `none` disables thinking on Ollama)
- `HARNESS_MODEL_TIMEOUT_MS` (default `180000`, or 3 minutes; covers cold model loading and response generation; increase for slower models)
- `HARNESS_REDACT_SECRET_1`, `HARNESS_REDACT_SECRET_2` (optional explicit redactions)

## Commands

```powershell
npm start -- --help
npm start -- review --root . --file src/server.js --request "Review asynchronous lifecycle and error handling."
npm start -- review --root . --search "Promise.all" --request "Review concurrency bounds." --format json
npm start -- replay --bundle C:\harness-runs\<run-id>.replay.json --format terminal
npm test
```

## Default deterministic collection strategy

When no `--file` is provided:

1. Run `fd --type f --hidden --color never --exclude .git --exclude node_modules .` from the reviewed root.
2. Sort results deterministically.
3. Read bounded text files with Node fs APIs.
4. Apply redaction before model submission.

Optional `--search` terms are executed with:

- `rg --json --fixed-strings --color never -- <pattern> <root>`

Policy and limits:

- No shell invocation (`spawn(..., shell: false)`).
- Option injection blocked for paths/patterns starting with `-`.
- Sensitive paths blocked by default (`.env`, keys, kube config, credentials markers); `.env.example` is allowed as a non-secret template.
- Bounded files, matches, bytes per file, aggregate evidence bytes, stdout/stderr bytes, and model response bytes.
- Search exit code `1` (no match) is accepted as empty evidence.
- Symlink containment checks rely on canonical path checks and are not a full OS sandbox against concurrent hostile mutation.
- During automatic file discovery, blocked/unsupported files are skipped; explicitly requested files still fail fast on policy violations.

## Output and replay

- Manifest: metadata-only sanitized artifact (`<run-id>.manifest.json`), written only for successful runs. Failed runs report their error on stderr and leave no manifest.
- Replay bundle: optional (`--replay`) sanitized inputs needed for deterministic offline replay.
- Artifacts are written to an explicit output directory outside the reviewed repository root.

## Exit/error behavior

Errors are emitted as structured JSON to stderr with stable `code` values (for example `E_CONFIG_INVALID`, `E_EXECUTABLE_NOT_FOUND`, `E_REVIEW_SCHEMA_INVALID`).

For `E_REVIEW_SCHEMA_INVALID`, see the [developer walkthrough](docs/review-schema-walkthrough.md) covering the request flow, the missing-schema root cause, and why valid JSON can still fail review validation.

Model output errors:

- `E_MODEL_OUTPUT_TRUNCATED`: the model hit `HARNESS_MODEL_MAX_TOKENS` before finishing. Details include `maxTokens`, `completionTokens`, and `contentChars`. With thinking models, `contentChars: 0` usually means hidden reasoning used the whole budget; set `HARNESS_MODEL_REASONING_EFFORT=none` or raise `HARNESS_MODEL_MAX_TOKENS`.
- `E_MODEL_OUTPUT_NOT_JSON`: the model finished but its content was not a bare JSON object. Markdown fences and surrounding prose are rejected, not repaired.

## Sizing for local models

The prompt is capped at 80,000 characters (`maxPromptChars` in `src/config.js`), roughly 22–23k tokens for code-heavy evidence. The prompt plus `HARNESS_MODEL_MAX_TOKENS` must fit the server's context window, or the server may silently truncate the prompt.

For example, Ollama on a 24 GB GPU runs `gemma4:26b` with a 32,768-token context, which leaves room for about 8k output tokens. Run `ollama ps` during a review to see the context in use. For a larger output budget, raise the server context (`OLLAMA_CONTEXT_LENGTH`) or lower `maxPromptChars`. Evidence that does not fit is omitted deterministically and listed in `omittedEvidenceIds`.

## Limitations (milestone one)

- No Git diff review.
- No model-directed tool loop.
- No `az`, `oc`, `itsoctrl`, MCP transport, Express API, or persistent jobs yet.
- Child process termination targets the direct child only; descendant termination is not guaranteed.
- Redaction reduces accidental exposure but is not complete secret protection.
- OpenAI-compatible servers vary; request options are best-effort and still locally validated. Support for `response_format: json_schema` and `reasoning_effort` differs between servers, which may ignore or reject them.

## Roadmap

See architecture and threat-model docs for deferred work and extension guidance:

- `docs/architecture.md`
- `docs/threat-model.md`
- `docs/adding-a-capability.md`
- `docs/adding-a-model-provider.md`
