import Ajv from 'ajv';
import { HarnessError } from '../errors.js';
import { reviewSchema } from './schema.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(reviewSchema);

export function validateReviewPayload(payload) {
  const ok = validate(payload);
  if (!ok) {
    throw new HarnessError(
      'E_REVIEW_SCHEMA_INVALID',
      'Model response did not match review schema.',
      {
        errors: validate.errors,
      }
    );
  }
  return payload;
}

export function verifyEvidenceReferences(
  review,
  suppliedEvidenceIds,
  omittedEvidenceIds = []
) {
  const known = new Set(suppliedEvidenceIds);
  const omitted = new Set(omittedEvidenceIds);
  const unknown = [];

  for (const finding of review.findings) {
    for (const id of finding.evidenceIds) {
      if (!known.has(id)) unknown.push(id);
    }
  }

  for (const id of review.limitations.omittedEvidenceIds) {
    if (!omitted.has(id)) unknown.push(id);
  }

  if (unknown.length) {
    throw new HarnessError(
      'E_UNKNOWN_EVIDENCE_REFERENCE',
      'Model referenced evidence not supplied in context.',
      {
        unknown: [...new Set(unknown)].sort(),
      }
    );
  }
}
