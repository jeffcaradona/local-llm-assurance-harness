import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { HarnessError } from '../errors.js';
import {
  validateReviewPayload,
  verifyEvidenceReferences,
} from '../review/validator.js';
import { renderReviewReport } from '../reporting/render.js';
import { compilePromptContext } from '../context/compiler.js';
import {
  executeInvestigation,
  investigationDigest,
} from './investigationLoop.js';
import {
  INVESTIGATION_PROTOCOL_VERSION,
  validateInvestigationAction,
} from './investigationProtocol.js';

function invalid(condition) {
  if (!condition) {
    throw new HarnessError(
      'E_REPLAY_INVALID',
      'Invalid investigation replay record.'
    );
  }
}

function object(value, required, optional = []) {
  invalid(value !== null && typeof value === 'object' && !Array.isArray(value));
  invalid(required.every((key) => Object.hasOwn(value, key)));
  invalid(
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key)
    )
  );
}

function integer(value, minimum = 0, maximum = 2_147_483_647) {
  invalid(Number.isSafeInteger(value) && value >= minimum && value <= maximum);
}

function strings(value, maximum = Number.MAX_SAFE_INTEGER) {
  invalid(
    Array.isArray(value) &&
      value.every((item) => typeof item === 'string' && item.length <= maximum)
  );
}

function timing(value, maximum) {
  invalid(Number.isFinite(value) && value >= 0 && value <= maximum);
}

function match(actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new HarnessError(
      'E_REPLAY_MISMATCH',
      'Recorded investigation does not reproduce its execution.'
    );
  }
}

function validateInvestigationBundle(bundle) {
  object(
    bundle,
    [
      'format',
      'version',
      'request',
      'selectedFiles',
      'searches',
      'trustedInstructions',
      'redaction',
      'config',
      'started',
      'events',
      'evidence',
      'review',
      'includedEvidenceIds',
      'omittedEvidenceIds',
      'investigation',
      'digest',
    ],
    ['runId']
  );
  invalid(
    bundle.format === 'investigation' &&
      bundle.version === INVESTIGATION_PROTOCOL_VERSION
  );
  invalid(bundle.runId === undefined || typeof bundle.runId === 'string');
  invalid(
    typeof bundle.digest === 'string' && /^[a-f0-9]{64}$/.test(bundle.digest)
  );
  invalid(bundle.digest === investigationDigest(bundle));
  object(bundle.redaction, ['explicitSecrets', 'patternCount', 'note']);
  integer(bundle.redaction.explicitSecrets);
  integer(bundle.redaction.patternCount);
  invalid(typeof bundle.redaction.note === 'string');
  const { config, investigation } = bundle;
  object(config, ['investigation', 'limits', 'model']);
  object(config.investigation, ['maxModelCalls', 'maxToolCalls', 'timeoutMs']);
  integer(config.investigation.maxModelCalls, 1, 100);
  integer(config.investigation.maxToolCalls, 0, 100);
  integer(config.investigation.timeoutMs, 1);
  object(config.limits, [
    'maxFiles',
    'maxSearchMatches',
    'maxFileBytes',
    'maxEvidenceBytes',
  ]);
  for (const value of Object.values(config.limits)) integer(value, 1);
  object(config.model, ['maxPromptChars', 'maxResponseBytes']);
  for (const value of Object.values(config.model)) integer(value, 1);
  invalid(
    typeof bundle.request === 'string' &&
      bundle.request.length <= config.model.maxPromptChars
  );
  strings(bundle.selectedFiles, config.model.maxPromptChars);
  strings(bundle.searches, config.model.maxPromptChars);
  invalid(
    [...bundle.selectedFiles, ...bundle.searches].every(
      (value) => value.length > 0
    )
  );
  invalid(Array.isArray(bundle.trustedInstructions));
  for (const instruction of bundle.trustedInstructions) {
    object(instruction, ['filePath', 'content']);
    invalid(
      typeof instruction.filePath === 'string' &&
        typeof instruction.content === 'string'
    );
    invalid(
      instruction.filePath.length + instruction.content.length <=
        config.model.maxPromptChars
    );
  }
  integer(bundle.started, 0, 8_640_000_000_000_000);
  invalid(Array.isArray(bundle.events) && Array.isArray(bundle.evidence));
  strings(bundle.includedEvidenceIds);
  strings(bundle.omittedEvidenceIds);
  object(investigation, [
    'mode',
    'protocolVersion',
    'modelCalls',
    'toolCalls',
    'seedCalls',
    'elapsedMs',
    'budgetForced',
    'stopReason',
    'limitations',
    'collectedEvidenceIds',
    'omittedEvidenceIds',
    'turns',
  ]);
  invalid(
    investigation.mode === 'investigation' &&
      investigation.protocolVersion === INVESTIGATION_PROTOCOL_VERSION
  );
  integer(investigation.modelCalls, 1, config.investigation.maxModelCalls);
  integer(investigation.toolCalls, 0, config.investigation.maxToolCalls);
  integer(
    investigation.seedCalls,
    0,
    bundle.selectedFiles.length + bundle.searches.length
  );
  invalid(
    typeof investigation.budgetForced === 'boolean' &&
      typeof investigation.stopReason === 'string'
  );
  for (const key of [
    'limitations',
    'collectedEvidenceIds',
    'omittedEvidenceIds',
  ])
    strings(investigation[key]);
  timing(investigation.elapsedMs, config.investigation.timeoutMs);
  invalid(Array.isArray(investigation.turns));
  invalid(bundle.events.length === investigation.turns.length);
  invalid(
    bundle.events.length ===
      investigation.modelCalls +
        investigation.toolCalls +
        investigation.seedCalls
  );
  let elapsed = 0;
  for (const turn of investigation.turns) {
    invalid(turn !== null && typeof turn === 'object');
    timing(turn.elapsedMs, investigation.elapsedMs);
    elapsed += turn.elapsedMs;
  }
  timing(elapsed, investigation.elapsedMs);
  for (const event of bundle.events) {
    invalid(event !== null && typeof event === 'object');
    invalid(typeof event.callId === 'string');
    if (event.kind === 'model') {
      object(event, ['kind', 'callId', 'finalOnly', 'context', 'action']);
      invalid(typeof event.finalOnly === 'boolean');
      object(event.context, [
        'systemPrompt',
        'userPrompt',
        'responseSchema',
        'trustedInstructions',
        'includedEvidenceIds',
        'omittedEvidenceIds',
        'usedChars',
      ]);
      try {
        validateInvestigationAction(event.action);
      } catch {
        invalid(false);
      }
    } else {
      object(event, [
        'kind',
        'seed',
        'callId',
        'tool',
        'arguments',
        'bounds',
        'outcome',
        'result',
      ]);
      invalid(event.kind === 'tool' && typeof event.seed === 'boolean');
      if (event.seed) {
        invalid(
          ['filesystem.readTextFile', 'filesystem.searchText'].includes(
            event.tool
          )
        );
        const key =
          event.tool === 'filesystem.readTextFile' ? 'path' : 'pattern';
        object(event.arguments, [key]);
        invalid(
          typeof event.arguments[key] === 'string' &&
            event.arguments[key].length > 0 &&
            event.arguments[key].length <= config.model.maxPromptChars
        );
      } else {
        try {
          validateInvestigationAction({
            action: 'tool',
            tool: event.tool,
            arguments: event.arguments,
          });
        } catch {
          invalid(false);
        }
      }
      object(event.bounds, ['maxBytes', 'maxMatches', 'limit']);
      for (const value of Object.values(event.bounds)) integer(value);
      object(
        event.outcome,
        [
          'status',
          'records',
          'paths',
          'recordCount',
          'consideredRecords',
          'pathCount',
          'truncated',
        ],
        ['error']
      );
      invalid(['success', 'error'].includes(event.outcome.status));
      invalid(
        typeof event.outcome.truncated === 'boolean' &&
          Array.isArray(event.outcome.records)
      );
      integer(event.outcome.recordCount, event.outcome.records.length);
      const maximumConsidered =
        event.outcome.status === 'error' ||
        event.tool === 'filesystem.findFiles'
          ? 0
          : event.tool === 'filesystem.readTextFile'
            ? 1
            : event.bounds.maxMatches;
      integer(
        event.outcome.consideredRecords,
        event.outcome.records.length,
        Math.min(event.outcome.recordCount, maximumConsidered)
      );
      strings(event.outcome.paths);
      integer(event.outcome.pathCount, event.outcome.paths.length);
      if (event.outcome.status === 'error') {
        object(event.outcome.error, ['code', 'message']);
        invalid(
          typeof event.outcome.error.code === 'string' &&
            typeof event.outcome.error.message === 'string'
        );
      } else invalid(event.outcome.error === undefined);
      for (const record of event.outcome.records) {
        object(record, [
          'relativePath',
          'lineStart',
          'lineEnd',
          'content',
          'retainedBytes',
          'originalBytes',
          'truncated',
          'redaction',
        ]);
        invalid(typeof record.relativePath === 'string');
        invalid(
          typeof record.content === 'string' &&
            typeof record.truncated === 'boolean'
        );
        integer(record.retainedBytes, 0, config.limits.maxFileBytes);
        integer(record.originalBytes, 0, Number.MAX_SAFE_INTEGER);
        invalid(record.retainedBytes === Buffer.byteLength(record.content));
        if (record.lineStart !== null || record.lineEnd !== null) {
          integer(record.lineStart, 1, Number.MAX_SAFE_INTEGER);
          integer(record.lineEnd, record.lineStart, Number.MAX_SAFE_INTEGER);
        }
        invalid(
          record.redaction !== null &&
            typeof record.redaction === 'object' &&
            !Array.isArray(record.redaction)
        );
      }
    }
  }
  try {
    validateReviewPayload(bundle.review);
  } catch {
    invalid(false);
  }
}

async function replayInvestigation(bundle, format) {
  validateInvestigationBundle(bundle);
  let cursor = 0;
  let result;
  try {
    result = await executeInvestigation({
      config: bundle.config,
      request: bundle.request,
      selectedFiles: bundle.selectedFiles,
      searches: bundle.searches,
      trustedInstructions: bundle.trustedInstructions,
      now: () => bundle.started,
      redactor: { redact: (value) => value, describe: () => bundle.redaction },
      exchange(invocation) {
        const event = bundle.events[cursor++];
        if (!event) match(invocation, undefined);
        const {
          action,
          outcome,
          result: _result,
          ...recordedInvocation
        } = event;
        match(invocation, recordedInvocation);
        return structuredClone(invocation.kind === 'model' ? action : outcome);
      },
    });
  } catch (error) {
    if (error.code === 'E_REPLAY_MISMATCH') throw error;
    throw new HarnessError(
      'E_REPLAY_MISMATCH',
      'Recorded investigation cannot be reproduced.'
    );
  }
  match(cursor, bundle.events.length);
  const withoutTiming = ({ elapsedMs: _elapsedMs, turns, ...metadata }) => ({
    ...metadata,
    turns: turns.map(({ elapsedMs: _turnElapsedMs, ...turn }) => turn),
  });
  match(
    withoutTiming(result.investigation),
    withoutTiming(bundle.investigation)
  );
  for (const key of [
    'request',
    'selectedFiles',
    'searches',
    'trustedInstructions',
    'events',
    'evidence',
    'review',
    'includedEvidenceIds',
    'omittedEvidenceIds',
  ])
    match(result.replayBundle[key], bundle[key]);
  return renderReviewReport({
    format,
    review: result.review,
    request: bundle.request,
    includedEvidenceIds: result.context.includedEvidenceIds,
    omittedEvidenceIds: result.context.omittedEvidenceIds,
    investigation: bundle.investigation,
    runId: bundle.runId ?? 'replay',
  });
}

export function createReplayOrchestrator() {
  return {
    async replay({ bundlePath, format = 'terminal' }) {
      const raw = await readFile(bundlePath, 'utf8');
      let bundle;
      try {
        bundle = JSON.parse(raw);
      } catch {
        throw new HarnessError(
          'E_REPLAY_INVALID',
          'Replay bundle is not valid JSON.'
        );
      }
      if (
        bundle &&
        (Object.hasOwn(bundle, 'format') ||
          Object.hasOwn(bundle, 'version') ||
          Object.hasOwn(bundle, 'investigation') ||
          Object.hasOwn(bundle, 'events'))
      ) {
        return replayInvestigation(bundle, format);
      }

      if (
        !bundle?.review ||
        !bundle?.includedEvidenceIds ||
        !bundle?.request ||
        !Array.isArray(bundle?.evidence)
      ) {
        throw new HarnessError(
          'E_REPLAY_UNSUPPORTED',
          'Replay bundle did not include review artifacts.'
        );
      }

      const context = await compilePromptContext({
        request: bundle.request,
        evidence: bundle.evidence,
        trustedInstructions: bundle.trustedInstructions ?? [],
        maxChars: bundle.maxPromptChars,
      });
      if (
        context.systemPrompt !== bundle.systemPrompt ||
        context.userPrompt !== bundle.userPrompt ||
        JSON.stringify(context.includedEvidenceIds) !==
          JSON.stringify(bundle.includedEvidenceIds) ||
        JSON.stringify(context.omittedEvidenceIds) !==
          JSON.stringify(bundle.omittedEvidenceIds ?? [])
      ) {
        throw new HarnessError(
          'E_REPLAY_MISMATCH',
          'Replay inputs do not reproduce the stored prompt context.'
        );
      }

      validateReviewPayload(bundle.review);
      verifyEvidenceReferences(
        bundle.review,
        bundle.includedEvidenceIds,
        bundle.omittedEvidenceIds ?? []
      );

      return renderReviewReport({
        format,
        review: bundle.review,
        request: bundle.request,
        includedEvidenceIds: bundle.includedEvidenceIds,
        omittedEvidenceIds: bundle.omittedEvidenceIds ?? [],
        runId: bundle.runId ?? 'replay',
      });
    },
  };
}
