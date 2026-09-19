import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePromptContext } from '../src/context/compiler.js';
import { validateReviewPayload, verifyEvidenceReferences } from '../src/review/validator.js';
import { REVIEW_SCHEMA_VERSION, modelReviewSchema, reviewSchema } from '../src/review/schema.js';

test('context compilation is deterministic and tracks omissions', async () => {
  const evidence = [
    { id: 'ev-0002', sourcePath: 'b.js', lineRange: [1, 1], content: 'b'.repeat(2000) },
    { id: 'ev-0001', sourcePath: 'a.js', lineRange: [1, 1], content: 'a' }
  ];
  const baseline = await compilePromptContext({ request: 'r', evidence: [], maxChars: 10_000 });
  const maxChars = baseline.systemPrompt.length + baseline.userPrompt.length + 100;
  const context = await compilePromptContext({ request: 'r', evidence, instructionFiles: [], maxChars });
  assert.deepEqual(context.includedEvidenceIds, ['ev-0001']);
  assert.deepEqual(context.omittedEvidenceIds, ['ev-0002']);
  assert.ok(context.systemPrompt.length + context.userPrompt.length <= maxChars);
  assert.deepEqual(await compilePromptContext({ request: 'r', evidence: [...evidence].reverse(), maxChars }), context);
});

test('context supplies the complete validator schema even with no evidence', async () => {
  const context = await compilePromptContext({ request: 'Review concurrency bounds.', evidence: [], maxChars: 10_000 });
  const schemaText = context.systemPrompt.split('Review response JSON Schema:\n')[1];
  const { $id, ...expectedSchema } = reviewSchema;
  assert.ok($id);
  assert.deepEqual(JSON.parse(schemaText), expectedSchema);
  assert.equal('$id' in JSON.parse(schemaText), false);
  assert.equal(context.responseSchema, modelReviewSchema);
  assert.match(context.systemPrompt, /Return only one JSON object/);
  assert.match(context.userPrompt, /No evidence supplied\./);

  const exactBudget = context.systemPrompt.length + context.userPrompt.length;
  assert.deepEqual(await compilePromptContext({ request: 'Review concurrency bounds.', evidence: [], maxChars: exactBudget }), context);
  await assert.rejects(
    () => compilePromptContext({ request: 'Review concurrency bounds.', evidence: [], maxChars: exactBudget - 1 }),
    { code: 'E_PROMPT_BUDGET_EXCEEDED' }
  );
});

test('review validator still rejects valid JSON with the wrong review shape', () => {
  assert.throws(() => validateReviewPayload({ concurrency_bounds: [] }), (error) => {
    assert.equal(error.code, 'E_REVIEW_SCHEMA_INVALID');
    assert.ok(error.details.errors.some((item) => item.params.missingProperty === 'schemaVersion'));
    assert.ok(error.details.errors.some((item) => item.params.additionalProperty === 'concurrency_bounds'));
    return true;
  });
});

test('review validator rejects unknown evidence references', () => {
  const payload = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    summary: 'x',
    decision: 'needs_attention',
    observations: ['o'],
    inferences: [{ statement: 's', confidence: 'medium' }],
    findings: [
      {
        severity: 'low',
        category: 'c',
        explanation: 'e',
        consequence: 'k',
        recommendation: 'r',
        evidenceIds: ['ev-9999']
      }
    ],
    limitations: { notes: ['n'], omittedEvidenceIds: [] }
  };
  validateReviewPayload(payload);
  assert.throws(() => verifyEvidenceReferences(payload, ['ev-0001']), { code: 'E_UNKNOWN_EVIDENCE_REFERENCE' });
});
