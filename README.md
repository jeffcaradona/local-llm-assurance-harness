# local-llm-assurance-harness

Evidence-backed repository review harness with deterministic policy enforcement for local OpenAI-compatible LLM endpoints.

## Purpose

This project enforces capability boundaries and provenance around repository review:

- Markdown instructions provide trusted review policy only when explicitly selected.
- Repository content remains untrusted evidence.
- The harness owns evidence collection, limits, redaction, schema validation, and audit artifacts.

The default is **read-only repository review** with deterministic collection and offline replay. Opt-in investigation adds bounded, sequential model-directed collection; model responses and tool selection are not deterministic.

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
- `HARNESS_MODEL_MAX_TOKENS` (optional positive integer; limits generated response tokens, not the model context window; blank values are treated as unset)
- `HARNESS_MODEL_TEMPERATURE` (default `0.2`; must be between 0 and 2)
- `HARNESS_MODEL_REASONING_EFFORT` (optional: `none`, `low`, `medium`, or `high`; sent as `reasoning_effort`. Hidden reasoning counts against `HARNESS_MODEL_MAX_TOKENS`, so thinking models can exhaust the budget before emitting the review and fail with `E_MODEL_OUTPUT_TRUNCATED`; `none` disables thinking on Ollama)
- `HARNESS_MODEL_TIMEOUT_MS` (default `180000`, or 3 minutes; covers cold model loading and response generation; increase for slower models)
- `HARNESS_INVESTIGATE_MAX_MODEL_CALLS` (default `8`; integer `1..100`, including the final review call)
- `HARNESS_INVESTIGATE_MAX_TOOL_CALLS` (default `6`; integer `0..100`, model-requested tools only)
- `HARNESS_INVESTIGATE_TIMEOUT_MS` (default `600000`, or 10 minutes; integer `1..2147483647`, overall investigation deadline after admission)
- `HARNESS_REDACT_SECRET_1`, `HARNESS_REDACT_SECRET_2` (optional explicit redactions)

Investigation settings do not enable investigation: pass `--investigate` explicitly. Blank investigation settings use their defaults. The per-model-request timeout remains independent of the overall investigation deadline, which includes artifact persistence.

### Context length and response tokens

The context length reported by a model runtime is the total token capacity available to the request (input plus generated output). It is not a value that should be copied directly into `HARNESS_MODEL_MAX_TOKENS`. The harness bounds its input separately with an 80,000-character prompt budget; this is deliberately a character limit because the harness does not run the model's tokenizer.

`HARNESS_MODEL_MAX_TOKENS`, when set, is sent to the OpenAI-compatible endpoint as `max_tokens` and caps each generated response, not the entire investigation. When it is blank, the field is omitted and the endpoint chooses its default. A runtime's reported context window does not state its default or maximum generation length.

A practical starting point for a structured review is:

```dotenv
HARNESS_MODEL_BASE_URL=http://127.0.0.1:11434/v1
HARNESS_MODEL_ID=gemma4:26b
HARNESS_MODEL_MAX_TOKENS=8192
```

Increase the response cap if reviews are truncated, or reduce it if latency is more important. The endpoint must support the OpenAI-compatible `max_tokens` field, and input plus output must remain within its configured context window.

## Commands

```powershell
npm --silent start -- --help
npm --silent start -- review --root . --file src/lifecycle/manager.js --request "Review cancellation and shutdown."
npm --silent start -- review --root . --search "Promise.all" --request "Review concurrency bounds." --format json
npm --silent start -- replay --bundle "C:\harness-runs\RUN_ID.replay.json" --format terminal
npm test
```

### Opt-in bounded investigation

`--investigate` is a strict, review-only boolean flag: supply it once, without a value. Repetition, `--investigate=true`, `--investigate false`, and using it with `replay` are rejected.

Seeded investigation (run from the harness checkout; the artifact directory must be outside the reviewed root):

```powershell
npm --silent start -- review --root . --investigate --file src/lifecycle/manager.js --search "AbortController" --request "Investigate lifecycle manager cancellation and shutdown; cite retained evidence and state coverage limitations." --replay --output-dir ..\harness-runs --format json
```

Seedless investigation:

```powershell
npm --silent start -- review --root . --investigate --request "Locate and review lifecycle manager cancellation and shutdown; cite retained evidence and state coverage limitations." --replay --output-dir ..\harness-runs --format json
```

Without seeds, the first model call receives no repository evidence. There is **no automatic discovery sweep** in investigation mode: the model must request discovery, search, or reads. Optional `--file` and `--search` seeds consume cumulative evidence and collection resources, but not the model-requested tool-call cap.

One configured model returns one strict JSON action at a time:

- `{"action":"tool","tool":"filesystem.findFiles","arguments":{}}`
- `{"action":"tool","tool":"filesystem.searchText","arguments":{"pattern":"AbortController"}}`
- `{"action":"tool","tool":"filesystem.readTextFile","arguments":{"path":"src/lifecycle/manager.js"}}`
- A final action with `action: "final"` and `review` containing the existing review schema.

Only these three read-only tools are approved. No shell, mutations, infrastructure commands, delegation, parallel tool batches, or background jobs are exposed. Discovery paths are navigation metadata, not proof of file contents.

The last allowed model call is reserved for finalization. Reaching the tool-call cap, read/search collection limits, or evidence/navigation/context budget switches to a final-only turn; requesting another tool then fails rather than running it. Exhausting discovery paths alone does not prevent reading discovered files. A deadline, cancellation, or invalid final response fails the run; a final review is not guaranteed.

Contexts retain cumulative original redacted excerpts, not model-written replacements. Admitted evidence is never evicted to make room for later evidence. Identical records (capability, path, line range, retained content, original byte count, and truncation state) reuse IDs; changed records receive new IDs. This is not an atomic repository snapshot. An excerpt may be truncated to remaining evidence bytes; records that cannot fit the context are marked omitted and cannot substantiate findings. Results skipped after gathering stops are represented by omission counts, not invented evidence.

Replay the bundle path printed on stderr, replacing `RUN_ID` below:

```powershell
npm --silent start -- replay --bundle "..\harness-runs\RUN_ID.replay.json" --format json
```

For the next live run, use the seeded command again, for example:

```powershell
npm --silent start -- review --root . --investigate --file src/lifecycle/manager.js --request "Check whether cancellation reliably releases lifecycle resources." --replay --output-dir ..\harness-runs --format json
```

With `--format json`, stdout contains only the report; progress and artifact paths go to stderr. `npm --silent` suppresses npm's own script banner, which would otherwise contaminate JSON stdout. Keep stderr separate when piping the report.

## Default deterministic collection strategy

Without `--investigate`, when no `--file` is provided:

1. Run `fd --type f --hidden --color never --exclude .git --exclude node_modules .` from the reviewed root.
2. Sort results deterministically.
3. Read bounded text files with Node fs APIs.
4. Apply redaction before model submission.

Optional `--search` terms are executed with:

- `rg --json --fixed-strings --hidden --glob '!.git/**' --glob '!node_modules/**' --max-count <limit> --max-filesize <limit> --color never -- <pattern> <root>`

Policy and limits:

- No shell invocation (`spawn(..., shell: false)`).
- Option injection blocked for paths/patterns starting with `-`.
- Sensitive paths blocked by default (`.env`, keys, kube config, credentials markers); `.env.example` is allowed as a non-secret template.
- Bounded files, matches, bytes per file, aggregate evidence bytes, stdout/stderr bytes, and model response bytes.
- Search exit code `1` (no match) is accepted as empty evidence.
- A symlink used as the selected root is resolved canonically; symlinks beneath that root are blocked. Containment checks are not a full OS sandbox against concurrent hostile mutation.
- During automatic file discovery, blocked/unsupported files are skipped; explicitly requested files still fail fast on policy violations.

## Output and replay

- Manifest: metadata-only sanitized artifact (`<run-id>.manifest.json`), published last as the success marker. Failures report errors on stderr, not a successful report.
- Investigation manifests add safe counts, turn/status metadata, stop reasons, and evidence inclusion/omission IDs, not prompts, tool arguments, or source excerpts. Investigation failures report safe stage/count metadata on stderr when available, not a success artifact.
- Replay bundle: optional (`--replay`) redacted evidence and inputs for offline verification. Investigation bundles are separately versioned and preserve sanitized actions and outcomes needed to verify the recorded execution. Replay does not rerun model inference or filesystem tools, reproduce model nondeterminism, establish authenticity, or prove findings correct. Legacy single-pass replay remains unchanged.
- Redaction does not declassify source code: replay bundles can still contain confidential excerpts, requests, and instructions. Protect them accordingly.
- Artifacts are written to an explicit output directory outside the reviewed repository root.
- Persistence stages files inside that output directory, publishes optional replay before the manifest, and preserves existing files on name collisions. Abort/failure triggers best-effort cleanup of this run's staging and newly published artifacts. Cleanup can finish after in-flight filesystem IO settles; crashes or cleanup failures can leave residual files.

## Exit/error behavior

Errors are emitted as structured JSON to stderr with stable `code` values (for example `E_CONFIG_INVALID`, `E_EXECUTABLE_NOT_FOUND`, `E_REVIEW_SCHEMA_INVALID`).

For `E_REVIEW_SCHEMA_INVALID`, see the [developer walkthrough](docs/review-schema-walkthrough.md) covering the request flow, the missing-schema root cause, and why valid JSON can still fail review validation.

Model output errors:

- `E_MODEL_OUTPUT_TRUNCATED`: the model hit `HARNESS_MODEL_MAX_TOKENS` before finishing. Details include `maxTokens`, `completionTokens`, and `contentChars`. With thinking models, `contentChars: 0` usually means hidden reasoning used the whole budget; set `HARNESS_MODEL_REASONING_EFFORT=none` or raise `HARNESS_MODEL_MAX_TOKENS`.
- `E_MODEL_OUTPUT_NOT_JSON`: the model finished but its content was not a bare JSON object. Markdown fences and surrounding prose are rejected, not repaired.
- `E_INVESTIGATION_ACTION_INVALID`: an action did not match the strict investigation protocol.
- `E_INVESTIGATION_FINAL_ONLY`: a tool was requested after gathering ended.
- `E_INVESTIGATION_TIMEOUT`: the overall investigation deadline expired; cancellation uses `E_ABORTED`.

## Sizing for local models

The prompt is capped at 80,000 characters (`maxPromptChars` in `src/config.js`), roughly 22–23k tokens for code-heavy evidence. The prompt plus `HARNESS_MODEL_MAX_TOKENS` must fit the server's context window, or the server may silently truncate the prompt.

Run `ollama ps` during a review to see the context in use. For a larger output budget, raise the server context (`OLLAMA_CONTEXT_LENGTH`) or lower `maxPromptChars`. Single-pass evidence that does not fit is omitted deterministically and listed in `omittedEvidenceIds`. Investigation additionally counts the action schema and reserves space for navigation, limitations, and finalization; it stops gathering rather than evicting retained evidence. An initial request/instruction context too large even without evidence fails with `E_PROMPT_BUDGET_EXCEEDED`.

## Limitations (milestone one)

- No Git diff review.
- Investigation is bounded, single-model, and sequential; it is not a general autonomous agent.
- No `az`, `oc`, `itsoctrl`, MCP transport, Express API, or persistent jobs yet.
- Child process termination targets the direct child only; descendant termination is not guaranteed.
- Aborting the HTTP request is not proof that the server stopped inference.
- Redaction reduces accidental exposure but is not complete secret protection.
- OpenAI-compatible servers vary; request options are best-effort and still locally validated. Support for `response_format: json_schema` and `reasoning_effort` differs between servers, which may ignore or reject them.

## Roadmap

See architecture and threat-model docs for deferred work and extension guidance:

- `docs/architecture.md`
- `docs/threat-model.md`
- `docs/adding-a-capability.md`
- `docs/adding-a-model-provider.md`
