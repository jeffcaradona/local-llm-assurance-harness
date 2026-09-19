import Ajv from 'ajv';
import { HarnessError } from '../errors.js';
import { modelReviewSchema } from '../review/schema.js';

export const INVESTIGATION_PROTOCOL_VERSION = '1.0.0';
export const toolArgumentSchemas = {
  'filesystem.findFiles': {
    type: 'object',
    additionalProperties: false,
    properties: {},
    required: [],
  },
  'filesystem.searchText': {
    type: 'object',
    additionalProperties: false,
    properties: {
      pattern: {
        type: 'string',
        minLength: 1,
        maxLength: 1024,
        pattern: '^[^\\u0000]+$',
      },
    },
    required: ['pattern'],
  },
  'filesystem.readTextFile': {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: {
        type: 'string',
        minLength: 1,
        maxLength: 1024,
        pattern: '^(?![\\\\/])(?![A-Za-z]:)[^\\u0000]+$',
      },
    },
    required: ['path'],
  },
};

const finalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'review'],
  properties: { action: { const: 'final' }, review: modelReviewSchema },
};
export const finalActionSchema = finalSchema;
export const investigationActionSchema = {
  oneOf: [
    finalSchema,
    ...Object.entries(toolArgumentSchemas).map(([tool, argumentsSchema]) => ({
      type: 'object',
      additionalProperties: false,
      required: ['action', 'tool', 'arguments'],
      properties: {
        action: { const: 'tool' },
        tool: { const: tool },
        arguments: argumentsSchema,
      },
    })),
  ],
};
const ajv = new Ajv({ strict: true, allErrors: true });
const validateAction = ajv.compile(investigationActionSchema);
const validateFinal = ajv.compile(finalActionSchema);

export function validateInvestigationAction(action, finalOnly = false) {
  if (finalOnly && action?.action === 'tool') {
    throw new HarnessError(
      'E_INVESTIGATION_FINAL_ONLY',
      'Tool request is forbidden on a final-only turn.'
    );
  }
  if (!(finalOnly ? validateFinal : validateAction)(action)) {
    throw new HarnessError(
      'E_INVESTIGATION_ACTION_INVALID',
      'Model response did not match the investigation action protocol.'
    );
  }
  return action;
}

export const toolDescriptions = [
  'filesystem.findFiles: {} — discover bounded file paths; paths are navigation metadata, not evidence of contents.',
  'filesystem.searchText: {"pattern": string} — fixed-string search, 1–1024 characters.',
  'filesystem.readTextFile: {"path": string} — read a bounded relative file path, 1–1024 characters.',
  'No root overrides, limits, flags, shell, mutations, delegation, or other tools are available.',
].join('\n');
