# Threat model

## Trust assumptions

- Repository files, filenames, and search hits are untrusted input.
- Model output is untrusted until validated.
- Trusted review instructions are only explicit operator-selected files.

## Key protections

- Named capability allowlist; no generic shell execution surface.
- Root containment checks with canonical path resolution.
- Denial of sensitive filename patterns by default.
- Option injection prevention for user-controlled path/pattern values.
- Subprocess execution with fixed executable names and argument arrays (`shell: false`).
- Bounded stdout/stderr, evidence bytes, prompt chars, and response bytes.
- Pre-model redaction and metadata-only default manifests.
- Strict JSON schema validation and evidence-reference verification.

## Residual risks

- Path checks are not a full sandbox against concurrent filesystem mutation.
- Direct child process termination does not guarantee termination of descendants.
- Pattern-based redaction cannot guarantee complete secret elimination.
- Sanitized replay bundles may still contain confidential source code.

## Operational guidance

- Keep model endpoint local by default; require explicit opt-in for non-local endpoints.
- Store run artifacts in dedicated non-repository paths with controlled access.
- Treat findings as evidence-backed claims, not proofs of correctness or safety.
