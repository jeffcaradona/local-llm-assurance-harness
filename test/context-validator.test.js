import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePromptContext } from '../src/context/compiler.js';
import { validateReviewPayload, verifyEvidenceReferences } from '../src/review/validator.js';
import { REVIEW_SCHEMA_VERSION } from '../src/review/schema.js';

test('context compilation is deterministic and tracks omissions', async () => {
  const evidence = [
    { id: 'ev-0002', sourcePath: 'b.js', lineRange: [1, 1], content: 'b'.repeat(2000) },
    { id: 'ev-0001', sourcePath: 'a.js', lineRange: [1, 1], content: 'a' }
  ];
  const context = await compilePromptContext({ request: 'r', evidence, instructionFiles: [], maxChars: 1000 });
  assert.deepEqual(context.includedEvidenceIds, ['ev-0001']);
  assert.deepEqual(context.omittedEvidenceIds, ['ev-0002']);
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
