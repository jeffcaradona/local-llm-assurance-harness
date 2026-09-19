# Junior developer walkthrough: a JSON response that fails review validation

The concurrency review command failed with `E_REVIEW_SCHEMA_INVALID` because the model returned an object containing `concurrency_bounds`, while the harness expects a particular review structure. This error is about the model's response format; it does not establish whether the reviewed code has a concurrency bug.

## Follow the request through the code

1. `src/orchestrator/reviewOrchestrator.js` collects repository evidence and asks the context compiler to prepare the model messages.
2. `src/context/compiler.js` builds a system message (review rules) and a user message (the request and evidence).
3. `src/model/openaiCompatibleProvider.js` sends those messages with `response_format: { type: 'json_schema', json_schema: { name: 'review', strict: true, schema } }`, then parses the returned text as JSON. Servers that support structured outputs (Ollama included) use the schema to constrain decoding. Before the fixes below, the provider sent `{ type: 'json_object' }`, which only guarantees JSON syntax and carries no review field definitions.
4. `src/review/validator.js` uses Ajv to check the parsed object against `src/review/schema.js`. A schema is a contract describing required fields, types, allowed values, and whether extra fields are permitted.
5. Only after validation and evidence-reference checks does the orchestrator render the report and persist artifacts. `--format json` controls report rendering; it does not supply the model's review contract.

## Root cause

Before this fix, the compiler told the model to review the repository and cite evidence, but never supplied the response schema. The provider asked for a JSON object, which still left the model to choose its own property names and structure. The harness then checked the result against a contract the model had not been given.

For example, `{"concurrency_bounds": []}` is valid JSON, but it is not a valid harness review. The seven `required` errors mean the top-level review fields are absent. The `additionalProperties` error means `concurrency_bounds` is not an allowed top-level field. These errors describe one shape mismatch, rather than eight separate transport failures. An empty `instancePath` means the error concerns the outermost object.

A minimal example of the expected structure is:

```json
{
  "schemaVersion": "1.0.0",
  "summary": "No findings in the supplied evidence.",
  "decision": "no_findings_in_supplied_evidence",
  "observations": [],
  "inferences": [],
  "findings": [],
  "limitations": {
    "notes": [],
    "omittedEvidenceIds": []
  }
}
```

This illustrates the structure, not a conclusion about your repository. Actual findings require the nested fields and evidence references defined in the schema.

## What changed and why

The context compiler now serializes `modelReviewSchema` into the system prompt. It is derived from the same `reviewSchema` the validator uses, minus the schema-level `$id`, so the model receives the complete contract, including nested finding fields and allowed decision values. Deriving it avoids maintaining a separate prompt description that could drift from validation.

The prompt explicitly asks for one JSON object without Markdown fences or extra properties. It also allows empty arrays when there are no supported entries, so satisfying the structure does not require inventing findings.

The compiler counts the schema and message text toward the existing character budget before adding evidence. Evidence is still sorted and omitted deterministically when it does not fit. If the schema, instructions, request, and empty-evidence message cannot fit, compilation fails before contacting the model. The smaller test budgets were adjusted to accommodate this newly required content. Separately, the production `maxPromptChars` limit was lowered from 240,000 to 80,000 characters so that the prompt (roughly 22–23k tokens) plus the output budget fits a 32k-token local context window.

## Follow-up: the model echoed `$id`

With the schema in the prompt but only `json_object` enforcement, a local model returned a review that included the schema's own `$id` key. Validation failed with a single `additionalProperties` error at an empty `instancePath`, naming `$id` as the extra property. The model had partly copied the schema instead of producing an instance of it.

Two changes address this:

- The prompt and request carry `modelReviewSchema`, which has no `$id`, so there is no schema metadata to copy.
- The provider sends the schema as a `json_schema` response format, so a supporting server cannot emit properties the schema forbids.

Server-side enforcement is now the primary guard against shape errors, but the harness does not depend on it. OpenAI-compatible servers vary, and some ignore `json_schema`. Local Ajv validation and evidence-reference checks still run on every response. The harness does not silently rename `concurrency_bounds`, strip Markdown fences, fill missing fields with invented defaults, or retry automatically.

## Verification

- Context tests check that the full schema appears even with no evidence, that exact budget boundaries hold, and that evidence selection stays deterministic and bounded.
- A local HTTP test checks the actual outgoing messages and parses and validates a fixture response. It does not claim to test a real model's instruction following.
- Provider tests check the exact `json_schema` request body, that the sent schema has no `$id`, and that fenced output is rejected rather than repaired.
- A regression test confirms that `{"concurrency_bounds": []}` still fails strict validation.

Run `npm test`, then retry the original review command against your configured model. A model can still produce an invalid response; this change fixes the missing contract in the prompt, rather than guaranteeing model compliance.
