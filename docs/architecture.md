# Architecture

## Ownership boundaries

- **CLI boundary (`src/cli.js`)**: argument parsing, signal wiring, and terminal IO.
- **Composition root (`src/harness.js`)**: dependency wiring and runtime configuration.
- **Orchestration (`src/orchestrator/*`)**: review workflow and replay workflow.
- **Admission/lifecycle (`src/admission`, `src/lifecycle`)**: bounded concurrency, queueing, shutdown.
- **Capabilities/policy (`src/capabilities`)**: approved operation names, input validation, policy denial.
- **Filesystem collection (`src/filesystem`)**: deterministic discovery/search/read with limits.
- **Subprocess execution (`src/subprocess`)**: timeout/cancellation, bounded output, structured exits.
- **Redaction (`src/redaction`)**: sensitive value/field masking before model or persistence.
- **Context compilation (`src/context`)**: deterministic evidence inclusion and omission tracking.
- **Model provider (`src/model`)**: OpenAI-compatible HTTP transport boundary.
- **Review contract (`src/review`)**: strict schema validation and evidence-reference verification.
- **Reporting (`src/reporting`)**: terminal/JSON render transformation.
- **Audit persistence (`src/audit`)**: sanitized manifests and optional replay bundles.

## Workflow

1. Validate runtime config and operator-selected root.
2. Collect bounded evidence via approved filesystem capabilities.
3. Load trusted instruction files explicitly provided by operator.
4. Compile bounded prompt with stable evidence identifiers.
5. Invoke configured local-compatible model endpoint, requesting output constrained to the review schema.
6. Validate response against strict schema version.
7. Verify model evidence references only target supplied evidence IDs.
8. Render report.
9. Persist sanitized manifest (and optional replay bundle) outside reviewed root.
10. Release request slot and resources.

## Determinism goals

- Sorted evidence ordering.
- Stable IDs (`ev-0001`, ...).
- Explicit omission metadata when budgets truncate context.
- Stable error codes for automated tests and integration callers.

## Deferred boundaries

Not implemented in milestone one: Git diff review, infrastructure CLI adapters, Copilot integration, MCP transport, API server, model-driven tool loops, multi-model evaluation, write-capability workflows.
