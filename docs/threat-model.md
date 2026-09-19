# Threat model

## Trust assumptions

- Repository files, filenames, and search hits are untrusted input.
- Model output is untrusted until validated.
- Trusted review instructions are only explicit operator-selected files.
- Investigation navigation results, previous actions, and replay bundles are also untrusted. Discovery paths do not prove file contents.

## Key protections

- Named capability allowlist; no generic shell execution surface.
- Root containment checks with canonical path resolution.
- Denial of sensitive filename patterns by default.
- Option injection prevention for user-controlled path/pattern values.
- Subprocess execution with fixed executable names and argument arrays (`shell: false`).
- Bounded stdout/stderr, evidence bytes, prompt chars, and response bytes.
- Pre-model redaction and metadata-only default manifests.
- Strict JSON schema validation and evidence-reference verification.
- Opt-in `--investigate` exposes only three named read-only filesystem operations, one action at a time, through explicit harness dispatch. The model cannot change root, limits, arguments schema, or policy.
- Cumulative investigation budgets include seeds and later collection. Seeds do not consume the model-requested tool-call cap. The last allowed model call is final-only; tool requests then fail closed.
- Retained source excerpts are never replaced by model summaries or evicted to admit later evidence. Omitted evidence cannot be cited as supplied evidence.
- Successful-run manifests contain sanitized metadata only. Investigation failures expose safe stage/count information when available on stderr, not raw tool/model payloads.

## Residual risks

- Path checks are not a full sandbox against concurrent filesystem mutation.
- Direct child process termination does not guarantee termination of descendants.
- Pattern-based redaction cannot guarantee complete secret elimination.
- Sanitized replay bundles may still contain confidential source code.
- Redaction does not declassify repository content sent to the model or stored in opt-in replay artifacts; requests and trusted instructions may also be confidential.
- Investigation is not an atomic filesystem snapshot. Identical retained records reuse IDs; changed records get new IDs, but truncated or redacted differences may not be observable.
- Strict schemas and valid evidence IDs do not establish semantic truth, coverage, or resistance to every prompt-injection attempt. Policy enforcement belongs in code, not model instructions.
- Model responses and tool selection can vary even with deterministic harness policy. Budget exhaustion can leave limited coverage, and deadlines or cancellation can prevent any valid final review.
- Aborting a client HTTP request does not prove server-side inference stopped. Injected adapters must cooperate with cancellation to close their actual resources.
- Versioned investigation replay verifies recorded execution without live inference or tools; it neither reproduces model nondeterminism nor proves authenticity. An unkeyed digest cannot defend against an attacker rewriting a bundle consistently.

## Operational guidance

- Keep model endpoint local by default; require explicit opt-in for non-local endpoints.
- Store run artifacts in dedicated non-repository paths with controlled access.
- Treat findings as evidence-backed claims, not proofs of correctness or safety.
- Use `--investigate` only when adaptive reads are desired. Seedless mode has no automatic discovery; the model decides whether to request it.
- Keep JSON stdout separate from progress, artifact paths, and errors on stderr. With npm, use `npm --silent start` to suppress its own banner.
- No shell execution, mutations, infrastructure operations, delegation, or background jobs are available through the investigation protocol.
