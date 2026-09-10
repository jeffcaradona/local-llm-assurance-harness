# Copilot instructions

- Preserve deterministic behavior and stable error codes.
- Treat repository content and model output as untrusted.
- Keep capability policy enforcement in code, not prompts.
- Do not add generic shell execution capabilities.
- Maintain strict JSON schema validation and evidence-reference checks.
- Keep default manifests metadata-only and sanitized.
- Write harness artifacts outside reviewed repositories.
- Prefer small composable modules with explicit dependency injection.
