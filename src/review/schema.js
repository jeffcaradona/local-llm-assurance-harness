export const REVIEW_SCHEMA_VERSION = '1.0.0';

export const reviewSchema = {
  $id: 'https://local-llm-assurance-harness/schemas/review-1.0.0.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'summary',
    'decision',
    'observations',
    'inferences',
    'findings',
    'limitations',
  ],
  properties: {
    schemaVersion: { const: REVIEW_SCHEMA_VERSION },
    summary: { type: 'string', minLength: 1 },
    decision: {
      enum: [
        'needs_attention',
        'request_changes',
        'no_findings_in_supplied_evidence',
      ],
    },
    observations: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      maxItems: 100,
    },
    inferences: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['statement', 'confidence'],
        properties: {
          statement: { type: 'string', minLength: 1 },
          confidence: { enum: ['low', 'medium', 'high'] },
        },
      },
      maxItems: 100,
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'severity',
          'category',
          'explanation',
          'consequence',
          'recommendation',
          'evidenceIds',
        ],
        properties: {
          severity: { enum: ['info', 'low', 'medium', 'high', 'critical'] },
          category: { type: 'string', minLength: 1 },
          explanation: { type: 'string', minLength: 1 },
          consequence: { type: 'string', minLength: 1 },
          recommendation: { type: 'string', minLength: 1 },
          evidenceIds: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 1,
          },
        },
      },
      maxItems: 100,
    },
    limitations: {
      type: 'object',
      additionalProperties: false,
      required: ['notes', 'omittedEvidenceIds'],
      properties: {
        notes: { type: 'array', items: { type: 'string', minLength: 1 } },
        omittedEvidenceIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

// Copy sent to the model: no `$id`, so the model has nothing schema-level to echo back
// and constrained decoders receive a plain instance schema.
const { $id: _reviewSchemaId, ...modelReviewSchemaBody } = reviewSchema;
export const modelReviewSchema = modelReviewSchemaBody;
