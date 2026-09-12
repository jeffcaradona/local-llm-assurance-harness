# Adding a capability

1. Define a **named** capability in `src/capabilities/registry.js`.
2. Document input contract, timeout, root restrictions, and risk level.
3. Validate all caller-controlled fields before invocation.
4. Ensure execution is deterministic and bounded.
5. Return structured output that can be mapped to evidence metadata.
6. Add tests for:
   - authorization denial,
   - invalid input rejection,
   - path/option injection protections,
   - output limit behavior,
   - abort/timeout races.

Do not add generic execution capabilities (`shell`, `exec`, `run`) and do not bypass the registry.
