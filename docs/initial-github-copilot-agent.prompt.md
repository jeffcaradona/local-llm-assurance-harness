# Project: local-llm-assurance-harness

Build a Node.js ESM application named `local-llm-assurance-harness`.

Its purpose is to produce evidence-backed reviews using a local LLM, with controlled access to repository files and, eventually, infrastructure command-line tools.

Implement a working first milestone with tests and documentation—not just scaffolding. Keep the scope proportional to a two-person homelab and a serious software-engineering portfolio project.

## Context and intent

I develop primarily on Windows using PowerShell and run production workloads on Linux.

My local tooling includes `az`, `oc`, `itsoctrl`, `fd`, `rg`, Git, and other CLIs. I also maintain Markdown instructions describing architecture, operational conventions, and review guidance.

The design principle is:

**Markdown supplies domain knowledge and judgment; the harness enforces capabilities, execution boundaries, resource limits, and provenance.**

The initial product is a read-only repository reviewer. Infrastructure diagnostics, Copilot integration, and model-driven tool loops come later.

## Technical preferences

* Modern JavaScript with native ESM and `"type": "module"`.
* Choose a currently supported Node.js LTS baseline, verify it against official documentation, and document the exact supported versions.
* JavaScript, not TypeScript; use JSDoc for important contracts.
* Functional core, imperative shell.
* Explicit dependency injection through a composition root.
* Promises and async/await with consistent asynchronous failure behavior.
* Native Node APIs where practical.
* Native `node:test` and `node:assert/strict`.
* Minimal dependencies, but use a maintained JSON Schema validator rather than creating an incomplete one.
* No framework, database, Express server, worker pool, or generic agent framework in milestone one.
* Comments should explain ownership, trade-offs, and non-obvious behavior.

Avoid mutable global state, hidden service locators, import-time I/O, detached promises, and monolithic files.

## First milestone: deterministic repository review

Implement this workflow:

1. Validate configuration and the explicitly selected repository root.
2. Collect bounded evidence using trusted filesystem capabilities.
3. Load explicitly selected, trusted review instructions.
4. Compile a bounded prompt with evidence identifiers.
5. Invoke an OpenAI-compatible local model endpoint.
6. Validate the model response against a versioned JSON Schema.
7. Verify references against the evidence actually included in the prompt.
8. Render a terminal or JSON report.
9. Persist a sanitized run manifest outside the reviewed repository.
10. Cleanly release all owned resources.

Start with deterministic collection—not model-directed tool selection.

Support explicit file selection and optional text searches. Document the default collection strategy, exclusion rules, ordering, and limits. Do not pretend to review a Git diff before diff support exists.

Representative commands:

```powershell
npm start -- --help
npm start -- review --root . --file src/server.js --request "Review asynchronous lifecycle and error handling."
npm start -- review --root . --search "Promise.all" --request "Review concurrency bounds." --format json
npm test
```

## Architecture and boundaries

Separate these responsibilities:

* Configuration and composition.
* Review orchestration.
* Capability registry and authorization.
* Filesystem collection.
* Subprocess execution.
* Redaction.
* Context compilation.
* Model-provider adapters.
* Review validation and evidence verification.
* Reporting.
* Audit persistence and replay.
* Lifecycle management.

Keep policy, validation, context selection, and report transformation deterministic and independently testable.

Create only abstractions that serve this milestone or establish a necessary external-system boundary. Avoid empty adapters and speculative frameworks.

## Trust and capability model

Treat repository content, filenames, command output, logs, and model responses as untrusted.

Repository text is evidence, not authority. Do not automatically promote discovered Markdown files into system instructions. Trusted instruction files must be explicitly selected through operator-controlled configuration.

Never expose generic capabilities such as:

```text
shell(command)
exec(command)
run(binary, args)
```

Provide named operations with validated inputs instead:

```text
filesystem.findFiles
filesystem.searchText
filesystem.readTextFile
```

Each capability must declare its input contract, allowed root, timeout, output limits, and risk level.

Only approved observation capabilities may execute in milestone one. “Read-only” does not mean “safe to disclose”: exclude credential files, private keys, kubeconfigs, environment files, and other configured sensitive paths by default.

Policy enforcement must exist in code, not merely in prompts.

## Filesystem and CLI execution

Use `fd` for discovery and `rg --json` for search. Use Node filesystem APIs for bounded file reads.

* Report unavailable dependencies with clear structured errors.
* Do not silently substitute different search behavior.
* Handle `rg` no-match status as a valid empty result.
* Use fixed executables and trusted argument construction.
* Use `spawn()` with argument arrays and `shell: false`.
* Prevent option injection, including patterns or paths beginning with `-`.
* Restrict working directories and inherited environment variables.
* Bound stdout and stderr separately.
* Bound file counts, match counts, file bytes, and total retained evidence.
* Reject binary or unsupported file content explicitly.
* Use deterministic result ordering.

Canonicalize the approved root and enforce containment. Do not follow symlinks or junctions outside it. Document filesystem race limitations honestly: path validation is not an OS sandbox against concurrent hostile mutation.

Create a shared subprocess runner with cancellation, deadlines, exactly-once settlement, listener cleanup, and structured exit information.

Account for Windows and Linux process termination. State and test the guarantees; do not claim killing a direct child necessarily terminates its descendants.

## Local model provider

Implement an adapter for a configurable OpenAI-compatible chat-completions endpoint.

Support configurable:

* Base URL and model identifier.
* Optional authentication.
* Request deadline.
* Response byte limit.
* Input budget.
* Generation limit where supported.

Start with non-streaming inference unless streaming is required for the first milestone. Bound response bytes while reading the HTTP body, before parsing JSON.

Use provider-supported structured output when available, but always validate locally. Do not assume all compatible servers support identical request options.

Reject unexpected redirects. Do not fall back to a hosted provider automatically. Require explicit operator configuration to send evidence to a non-local endpoint.

Normalize transport, timeout, HTTP, parsing, and schema failures into stable error codes. Do not retry indefinitely or log request bodies by default.

## Evidence and review contracts

Each evidence item must include:

* Run-local unique ID.
* Capability and relative source path.
* Line range where applicable.
* Sanitized content.
* Collection timestamp.
* Retained byte count.
* Original byte count when known.
* Truncation and redaction metadata.

The context compiler must preserve IDs and record which items were included or omitted. Use honest byte or character budgets unless actual model tokenization is implemented.

Require a strict, versioned review schema containing:

* Summary.
* Decision: `needs_attention`, `request_changes`, or `no_findings_in_supplied_evidence`.
* Observations.
* Inferences, with explicitly model-reported confidence.
* Findings: severity, category, explanation, consequence, recommendation, and evidence IDs.
* Limitations, including omitted or truncated evidence.

Validate every reference against evidence supplied to the model—not merely evidence collected earlier.

Known evidence IDs establish provenance, not truth. Do not claim the harness has proved a finding correct or the repository safe.

Treat a requested JSON format as a request, not a guarantee. Reject invalid output clearly; do not silently accept repaired or partially parsed findings.

## Cancellation, admission, and lifecycle

Propagate `AbortSignal` through collection, subprocesses, model calls, and orchestration.

Provide a small bounded admission controller with:

* Maximum active requests.
* Maximum queued requests.
* Explicit saturation errors.
* Queued cancellation.
* Slot release on every settlement path.

At shutdown:

1. Reject new work.
2. Cancel queued work.
3. Allow active work a configurable grace period.
4. Abort remaining work.
5. Clean up owned resources within a bounded deadline.

Place signal handling at the CLI boundary. Distinguish aborting the client request from proving the inference server stopped computation.

## Redaction, audit, and replay

Redact configured secret values and recognizable sensitive fields before evidence reaches the model or persistent output.

Do not describe pattern-based redaction as complete secret protection.

Default manifests should store sanitized metadata, statuses, limits, validation results, and provenance—not full prompts, evidence bodies, or model responses.

Offer an explicit opt-in sanitized replay bundle containing the content required for replay. Document that sanitized source code can still be confidential.

Replay must support deterministic prompt compilation, response validation, evidence-reference checks, and rendering without invoking tools or a model. A metadata-only manifest must not pretend to support full replay.

Write artifacts to an explicit output directory outside the reviewed root. Distinguish read-only review from authorized harness artifact writes.

## Testing

Tests must run without a live model or installed `fd`, `rg`, `az`, `oc`, or `itsoctrl`.

Use fake providers, injectable process adapters, synthetic replay fixtures, and controlled local HTTP servers where useful.

Cover:

* Configuration validation.
* Capability authorization and invalid inputs.
* Path traversal, symlink/junction containment, and option injection.
* Missing executables and search no-match results.
* Output limits and malformed tool output.
* Already-aborted signals and timeout/exit races.
* Queue saturation and cancellation.
* Resource release and exactly-once settlement.
* Redaction before model invocation and persistence.
* Oversized, malformed, and schema-invalid model responses.
* Unknown or omitted evidence references.
* Context truncation and deterministic ordering.
* Prompt-injection text remaining evidence rather than instructions.
* Cooperative shutdown and bounded forced shutdown.
* Replay without external calls.

Assert stable error codes rather than message wording. Avoid timing-based sleeps where controllable synchronization is possible.

## Documentation and repository setup

Create:

* `README.md`: purpose, setup, configuration, examples, limitations, exit codes, and roadmap.
* `docs/architecture.md`: boundaries and ownership.
* `docs/threat-model.md`: protections and residual risks.
* `docs/adding-a-capability.md`.
* `docs/adding-a-model-provider.md`.
* `.github/copilot-instructions.md`: enduring project rules.
* `.env.example` containing placeholders only.
* `.gitignore` covering credentials, local configuration, and run artifacts.
* CI running deterministic tests on the documented Windows and Linux runtime matrix.

Keep shell examples fully visible and individually copyable. Prefer single-line PowerShell commands; avoid heredocs and nested shell quoting.

Do not publish a repository, push commits, change remote settings, or select a license without explicit authorization.

## Deferred work

Document, but do not implement:

* Git diff review.
* Read-only `oc` and `az` adapters with explicit cluster/subscription context.
* `istioctl` integration after its real interface is supplied.
* GitHub Copilot CLI integration using a currently documented supported interface.
* MCP server transport.
* Express API.
* Model-directed tool loops with bounded iterations.
* Multi-model comparison and evaluation suites.
* Human-approved mutations.
* Persistent jobs and worker-thread preprocessing.

Do not assume a Copilot agent runtime has the same permissions or semantics as a raw model endpoint.

## Execution and acceptance

First inspect the repository and preserve existing work. Briefly state assumptions, dependencies, trust boundaries, and an implementation plan. Then build the working milestone.

Completion requires:

* Help and example commands work.
* Deterministic tests pass.
* A fake-provider end-to-end review succeeds.
* The real endpoint adapter is implemented.
* Resource bounds and cancellation are tested.
* Invalid responses cannot become successful reports.
* Evidence references are checked against supplied context.
* Audit and replay privacy behavior is documented.
* Unverified live integration behavior is clearly identified.

Finish with what was implemented, tests actually run, remaining limitations, and exact next commands. Do not claim live-model or cross-platform verification unless performed.
