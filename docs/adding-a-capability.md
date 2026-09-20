# Adding a capability

1. Define a **named** capability in `src/capabilities/registry.js`.
2. Document input contract, timeout, root restrictions, and risk level.
3. Validate all caller-controlled fields before invocation.
4. Ensure policy enforcement and result processing are deterministic and bounded; model selection of tools is not deterministic.
5. Return structured output that can be mapped to evidence metadata.
6. Add tests for:
   - authorization denial,
   - invalid input rejection,
   - path/option injection protections,
   - output limit behavior,
   - abort/timeout races.

Do not add generic execution capabilities (`shell`, `exec`, `run`) and do not bypass the registry.

## Investigation boundary

Adding a registry entry does **not** expose it to the model. The current investigation protocol deliberately approves only:

| Capability                | Model arguments | Result role                                   |
| ------------------------- | --------------- | --------------------------------------------- |
| `filesystem.findFiles`    | `{}`            | Bounded navigation paths, not source evidence |
| `filesystem.searchText`   | `{pattern}`     | Bounded fixed-string source matches           |
| `filesystem.readTextFile` | `{path}`        | Bounded source excerpt                        |

Path and pattern strings must contain 1–1024 characters. Extra properties are rejected. Root, resource limits, and cancellation signals come from the harness, never from model arguments.

If intentionally extending this boundary, update `src/orchestrator/investigationProtocol.js` schemas/descriptions and the explicit dispatch in `investigationLoop.js`, then update recorded-execution replay validation and tests together. Do not use a model-supplied name to resolve arbitrary functions. Preserve strict final-only rejection and the existing final review schema/evidence-reference checks.

Keep operations sequential and cancellation-aware. Account for aggregate resource use across seeds and model-requested calls; seeds consume collection/evidence limits but not the model tool-call cap. Sanitize and bound outcomes before they enter context or persistence. Approved recoverable failures use safe codes and generic messages, not raw subprocess stderr or adapter exceptions.

Discovery is navigation only. Source evidence must retain original redacted excerpts, stable identity, and inclusion/omission metadata. Identical retained records reuse IDs; changes create new IDs without evicting earlier admitted evidence. A capability must not imply an atomic repository snapshot.

Cover seed accounting, repeated and changed records, exhausted budgets, final-only behavior, safe errors, and offline replay consistency in tests. Keep manifests metadata-only and replay content opt-in. Shells, mutations, infrastructure adapters, delegation, and background jobs are outside this investigation contract.
