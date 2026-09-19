import { createHash } from 'node:crypto';
import { HarnessError } from '../errors.js';
import { createRedactor } from '../redaction.js';
import { compilePromptContext } from '../context/compiler.js';
import { compileInvestigationContext } from './investigationContext.js';
import {
  INVESTIGATION_PROTOCOL_VERSION,
  validateInvestigationAction,
} from './investigationProtocol.js';
import {
  validateReviewPayload,
  verifyEvidenceReferences,
} from '../review/validator.js';

const SAFE_TOOL_ERRORS = new Set([
  'E_FILE_NOT_FOUND',
  'E_PATH_OUT_OF_ROOT',
  'E_SENSITIVE_PATH_BLOCKED',
  'E_SYMLINK_BLOCKED',
  'E_BINARY_FILE_REJECTED',
  'E_PATH_RACE_DETECTED',
  'E_CAPABILITY_INPUT_INVALID',
  'E_EXECUTABLE_NOT_FOUND',
  'E_SUBPROCESS_TIMEOUT',
  'E_FIND_FAILED',
  'E_SEARCH_FAILED',
]);

export function sanitizeInvestigationValue(value, redactor) {
  if (typeof value === 'string') return redactor.redact(value);
  if (Array.isArray(value))
    return value.map((item) => sanitizeInvestigationValue(item, redactor));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeInvestigationValue(item, redactor),
      ])
    );
  }
  return value;
}

function checkAbort(signal) {
  if (!signal?.aborted) return;
  throw signal.reason?.code === 'E_INVESTIGATION_TIMEOUT'
    ? new HarnessError(
        'E_INVESTIGATION_TIMEOUT',
        'Investigation deadline expired.'
      )
    : new HarnessError('E_ABORTED', 'Investigation cancelled.');
}

// The boundary settles on cancellation even when an injected adapter is uncooperative.
// Adapters still own closing their actual resources when the signal is aborted.
async function cancellable(operation, signal) {
  checkAbort(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      try {
        checkAbort(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => {
        checkAbort(signal);
        return operation();
      }),
      aborted,
    ]);
    checkAbort(signal);
    return value;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function boundText(text, maxBytes) {
  let bounded = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  while (Buffer.byteLength(bounded) > maxBytes) bounded = bounded.slice(0, -1);
  return bounded;
}

function normalizeRecord(record, limits, redactor) {
  if (
    typeof record?.relativePath !== 'string' ||
    typeof record.content !== 'string'
  ) {
    throw new HarnessError('E_INTERNAL', 'Invalid capability result.');
  }
  const content = boundText(
    redactor.redact(record.content),
    limits.maxFileBytes
  );
  return {
    relativePath: redactor.redact(record.relativePath.replaceAll('\\', '/')),
    lineStart: record.lineStart ?? null,
    lineEnd: record.lineEnd ?? null,
    content,
    retainedBytes: Buffer.byteLength(content),
    originalBytes: record.originalBytes ?? Buffer.byteLength(record.content),
    truncated: Boolean(
      record.truncated || content !== redactor.redact(record.content)
    ),
    redaction: redactor.describe(),
  };
}

function recordIdentity(record, tool) {
  return JSON.stringify([
    tool,
    record.relativePath,
    record.lineStart,
    record.lineEnd,
    record.content,
    record.truncated,
    record.originalBytes,
  ]);
}

export function investigationDigest(bundle) {
  const { digest: _digest, runId: _runId, ...record } = bundle;
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

/**
 * Shared deterministic execution logic. Live IO and offline recorded events are
 * injected; this core never resolves a filesystem capability or model itself.
 */
export async function executeInvestigation({
  config,
  request,
  selectedFiles = [],
  searches = [],
  trustedInstructions = [],
  exchange,
  signal,
  redactor = createRedactor(),
  onProgress = () => {},
  now = Date.now,
  startedAt,
}) {
  const started = startedAt ?? now();
  const budget = config.investigation;
  const gatheringPossible = budget.maxModelCalls > 1 && budget.maxToolCalls > 0;
  const limits = config.limits;
  const evidence = [];
  const collected = [];
  const identities = new Map();
  const summaries = [];
  const limitations = [];
  const events = [];
  const turns = [];
  const navigationBudget = Math.min(
    4096,
    Math.floor(config.model.maxPromptChars / 8)
  );
  let modelCalls = 0;
  let toolCalls = 0;
  let seedCalls = 0;
  let totalBytes = 0;
  let collectedBytes = 0;
  let fileCalls = 0;
  let matchCount = 0;
  let discoveryCount = 0;
  let stopReason;
  let stage = 'seeds';
  let budgetForced = false;
  let context;
  const clean = (value) => sanitizeInvestigationValue(value, redactor);
  request = clean(request);
  trustedInstructions = clean(trustedInstructions);
  selectedFiles = [...new Set(clean(selectedFiles))].sort();
  searches = clean(searches);

  function checkExecution() {
    checkAbort(signal);
    if (now() - started >= budget.timeoutMs) {
      throw new HarnessError(
        'E_INVESTIGATION_TIMEOUT',
        'Investigation deadline expired.'
      );
    }
  }
  function limit(reason) {
    stopReason ??= reason;
    if (!limitations.includes(reason)) limitations.push(reason);
  }
  function metadata() {
    return {
      mode: 'investigation',
      protocolVersion: INVESTIGATION_PROTOCOL_VERSION,
      modelCalls,
      toolCalls,
      seedCalls,
      elapsedMs: Math.max(0, now() - started),
      budgetForced,
      stopReason: stopReason ?? 'final',
      limitations: [...limitations],
      collectedEvidenceIds: collected.map((item) => item.id),
      omittedEvidenceIds: collected
        .filter((item) => !evidence.includes(item))
        .map((item) => item.id),
      turns,
    };
  }
  function compile(finalOnly, items = evidence, reserve = false) {
    const result = compileInvestigationContext({
      request,
      trustedInstructions,
      evidence: items,
      summaries: reserve ? [] : summaries,
      limitations: reserve ? [] : limitations,
      omittedEvidenceIds: reserve
        ? []
        : collected
            .filter((item) => !items.includes(item))
            .map((item) => item.id),
      finalOnly,
      maxChars: config.model.maxPromptChars,
    });
    if (
      reserve &&
      result.usedChars + navigationBudget + 1024 > config.model.maxPromptChars
    ) {
      throw new HarnessError(
        'E_PROMPT_BUDGET_EXCEEDED',
        'Insufficient space reserved for investigation state.'
      );
    }
    result.omittedEvidenceIds = collected
      .filter((item) => !items.includes(item))
      .map((item) => item.id);
    return result;
  }
  function addSummary(summary) {
    if (JSON.stringify([...summaries, summary]).length <= navigationBudget)
      summaries.push(summary);
    else limit('navigation_budget');
  }
  function admit(record, tool) {
    const key = recordIdentity(record, tool);
    if (identities.has(key)) return identities.get(key);
    const item = {
      id: `ev-${String(collected.length + 1).padStart(4, '0')}`,
      capability: tool,
      sourcePath: record.relativePath,
      lineRange: record.lineStart ? [record.lineStart, record.lineEnd] : null,
      content: record.content,
      collectedAt: new Date(started).toISOString(),
      retainedBytes: record.retainedBytes,
      originalBytes: record.originalBytes,
      truncated: record.truncated,
      redaction: record.redaction,
    };
    collected.push(item);
    identities.set(key, item);
    if (item.truncated && !limitations.includes('truncated_evidence'))
      limitations.push('truncated_evidence');
    if (totalBytes + item.retainedBytes > limits.maxEvidenceBytes) {
      limit('evidence_budget');
      return item;
    }
    try {
      if (gatheringPossible) compile(false, [...evidence, item], true);
      compile(true, [...evidence, item], true);
    } catch (error) {
      if (error.code !== 'E_PROMPT_BUDGET_EXCEEDED') throw error;
      limit('context_budget');
      return item;
    }
    totalBytes += item.retainedBytes;
    evidence.push(item);
    if (totalBytes >= limits.maxEvidenceBytes) limit('evidence_budget');
    return item;
  }
  async function tool(tool, args, seed) {
    checkExecution();
    const callId = seed ? `seed-${++seedCalls}` : `call-${++toolCalls}`;
    if (tool === 'filesystem.readTextFile') fileCalls += 1;
    const availableMatches = Math.max(0, limits.maxSearchMatches - matchCount);
    const availablePaths = Math.max(0, limits.maxFiles - discoveryCount);
    const invocation = {
      kind: 'tool',
      seed,
      callId,
      tool,
      arguments: clean(args),
      bounds: {
        maxBytes: limits.maxFileBytes,
        maxMatches: availableMatches,
        limit: availablePaths,
      },
    };
    const begin = now();
    const raw = await cancellable(() => exchange(invocation), signal);
    checkExecution();
    const result = {
      callId,
      tool,
      status: raw.status,
      evidenceIds: [],
      omittedEvidenceIds: [],
      truncated: false,
    };
    let records = [];
    let paths = [];
    if (raw.status === 'error') {
      if (!SAFE_TOOL_ERRORS.has(raw.error?.code))
        throw new HarnessError('E_INTERNAL', 'Unexpected capability failure.');
      result.error = {
        code: raw.error.code,
        message: 'Approved filesystem operation could not be completed.',
      };
    } else if (raw.status === 'success') {
      if (tool === 'filesystem.findFiles') {
        if (
          !Array.isArray(raw.paths) ||
          raw.paths.some((path) => typeof path !== 'string')
        )
          throw new HarnessError('E_INTERNAL', 'Invalid discovery result.');
        paths = [
          ...new Set(
            clean(raw.paths)
              .map((path) => path.replaceAll('\\', '/'))
              .filter((path) => path.length <= 1024)
          ),
        ]
          .sort()
          .slice(0, availablePaths);
        discoveryCount += paths.length;
        result.paths = [];
        for (const path of paths) {
          if (
            JSON.stringify([...result.paths, path]).length >
            Math.min(1536, navigationBudget / 2)
          )
            break;
          result.paths.push(path);
        }
        result.omittedPaths =
          (raw.pathCount ?? raw.paths.length) - result.paths.length;
        result.truncated =
          raw.truncated === true ||
          (raw.pathCount ?? raw.paths.length) >= availablePaths ||
          result.omittedPaths > 0;
      } else {
        if (!Array.isArray(raw.records))
          throw new HarnessError('E_INTERNAL', 'Invalid evidence result.');
        const candidates = raw.records
          .slice(0, tool === 'filesystem.readTextFile' ? 1 : availableMatches)
          .map((record) => normalizeRecord(record, limits, redactor))
          .sort((a, b) =>
            JSON.stringify([
              a.relativePath,
              a.lineStart,
              a.content,
            ]).localeCompare(
              JSON.stringify([b.relativePath, b.lineStart, b.content])
            )
          );
        if (tool === 'filesystem.searchText') matchCount += candidates.length;
        for (const candidate of candidates) {
          const remaining = limits.maxEvidenceBytes - collectedBytes;
          if (remaining <= 0) {
            limit('evidence_budget');
            break;
          }
          const record = { ...candidate };
          if (
            !identities.has(recordIdentity(record, tool)) &&
            record.retainedBytes > remaining
          ) {
            record.content = boundText(record.content, remaining);
            record.retainedBytes = Buffer.byteLength(record.content);
            record.truncated = true;
          }
          const repeated = identities.has(recordIdentity(record, tool));
          records.push(record);
          const item = admit(record, tool);
          if (!repeated) collectedBytes += item.retainedBytes;
          (evidence.includes(item)
            ? result.evidenceIds
            : result.omittedEvidenceIds
          ).push(item.id);
          if (item.truncated) result.truncated = true;
          if (stopReason) break;
        }
        result.omittedRecords =
          (raw.recordCount ?? raw.records.length) - records.length;
        result.truncated ||=
          raw.truncated === true ||
          result.omittedRecords > 0 ||
          (tool === 'filesystem.searchText' &&
            candidates.length >= availableMatches);
      }
    } else throw new HarnessError('E_INTERNAL', 'Invalid tool outcome.');
    if (result.truncated && !limitations.includes('truncated_tool_result'))
      limitations.push('truncated_tool_result');
    addSummary(result);
    events.push({
      ...invocation,
      outcome: {
        status: result.status,
        records,
        paths,
        recordCount: raw.recordCount ?? raw.records?.length ?? 0,
        pathCount: raw.pathCount ?? raw.paths?.length ?? 0,
        truncated: raw.truncated === true,
        ...(result.error ? { error: result.error } : {}),
      },
      result,
    });
    turns.push({
      kind: seed ? 'seed' : 'tool',
      callId,
      tool,
      status: result.status,
      elapsedMs: Math.max(0, now() - begin),
      evidenceCount: result.evidenceIds.length,
      omittedCount: result.omittedEvidenceIds.length,
      truncated: result.truncated,
      ...(result.error ? { code: result.error.code } : {}),
    });
    if (fileCalls >= limits.maxFiles || matchCount >= limits.maxSearchMatches)
      limit('collection_budget');
  }
  try {
    checkExecution();
    // Fail before any IO if even an empty context cannot reserve finalization.
    if (gatheringPossible) compile(false, [], true);
    compile(true, [], true);
    for (const path of selectedFiles) {
      if (stopReason) break;
      await tool('filesystem.readTextFile', { path }, true);
    }
    for (const pattern of searches) {
      if (
        stopReason ||
        seedCalls >= limits.maxFiles + limits.maxSearchMatches
      ) {
        limit('collection_budget');
        break;
      }
      await tool('filesystem.searchText', { pattern }, true);
    }
    for (;;) {
      checkExecution();
      stage = 'model';
      const finalOnly = Boolean(
        stopReason ||
        toolCalls >= budget.maxToolCalls ||
        modelCalls === budget.maxModelCalls - 1
      );
      if (finalOnly) {
        budgetForced = true;
        if (!stopReason)
          limit(
            toolCalls >= budget.maxToolCalls ? 'tool_budget' : 'model_budget'
          );
      }
      context = compile(finalOnly);
      onProgress({ stage, modelCalls: modelCalls + 1, toolCalls, finalOnly });
      checkExecution();
      modelCalls += 1;
      const begin = now();
      const invocation = {
        kind: 'model',
        callId: `model-${modelCalls}`,
        finalOnly,
        context,
      };
      const rawAction = await cancellable(() => exchange(invocation), signal);
      checkExecution();
      if (
        Buffer.byteLength(JSON.stringify(rawAction) ?? '') >
        config.model.maxResponseBytes
      ) {
        throw new HarnessError(
          'E_MODEL_RESPONSE_TOO_LARGE',
          'Model response exceeded byte limit.'
        );
      }
      validateInvestigationAction(rawAction, finalOnly);
      const action = clean(rawAction);
      validateInvestigationAction(action, finalOnly);
      events.push({ ...invocation, action });
      turns.push({
        kind: 'model',
        callId: invocation.callId,
        status: action.action,
        finalOnly,
        elapsedMs: Math.max(0, now() - begin),
        includedEvidenceIds: context.includedEvidenceIds,
      });
      if (action.action === 'final') {
        stage = 'validation';
        validateReviewPayload(action.review);
        verifyEvidenceReferences(
          action.review,
          context.includedEvidenceIds,
          context.omittedEvidenceIds
        );
        checkExecution();
        const investigation = metadata();
        const replayBundle = {
          format: 'investigation',
          version: INVESTIGATION_PROTOCOL_VERSION,
          request,
          selectedFiles,
          searches,
          trustedInstructions,
          redaction: redactor.describe(),
          config,
          started,
          events,
          evidence: collected,
          review: action.review,
          includedEvidenceIds: context.includedEvidenceIds,
          omittedEvidenceIds: context.omittedEvidenceIds,
          investigation,
        };
        replayBundle.digest = investigationDigest(replayBundle);
        return {
          review: action.review,
          context,
          evidence: collected,
          investigation,
          replayBundle,
        };
      }
      stage = 'tool';
      await tool(action.tool, action.arguments, false);
    }
  } catch (error) {
    const code = signal?.aborted
      ? signal.reason?.code === 'E_INVESTIGATION_TIMEOUT'
        ? 'E_INVESTIGATION_TIMEOUT'
        : 'E_ABORTED'
      : error instanceof HarnessError
        ? error.code
        : 'E_INTERNAL';
    const failure = metadata();
    failure.stopReason = code;
    throw new HarnessError(
      code,
      'Investigation ended without a valid final review.',
      { stage, investigation: failure }
    );
  }
}

export async function runInvestigation({
  config,
  capabilities,
  provider,
  redactor = createRedactor(),
  request,
  selectedFiles = [],
  searches = [],
  instructionFiles = [],
  signal,
  onProgress,
  startedAt,
}) {
  const inputs = await cancellable(
    () =>
      compilePromptContext({
        request: redactor.redact(request),
        evidence: [],
        instructionFiles,
        maxChars: config.model.maxPromptChars,
        signal,
      }),
    signal
  );
  // Persist only the bounded, non-secret configuration needed for reconstruction.
  const replayConfig = {
    investigation: { ...config.investigation },
    limits: {
      maxFiles: config.limits.maxFiles,
      maxSearchMatches: config.limits.maxSearchMatches,
      maxFileBytes: config.limits.maxFileBytes,
      maxEvidenceBytes: config.limits.maxEvidenceBytes,
    },
    model: {
      maxPromptChars: config.model.maxPromptChars,
      maxResponseBytes:
        config.model.maxResponseBytes ??
        config.limits.maxResponseBytes ??
        512 * 1024,
    },
  };
  return executeInvestigation({
    config: replayConfig,
    request,
    selectedFiles,
    searches,
    trustedInstructions: inputs.trustedInstructions,
    signal,
    redactor,
    onProgress,
    startedAt,
    async exchange(invocation) {
      if (invocation.kind === 'model') {
        return provider.complete({ ...invocation.context, signal });
      }
      const controller = new AbortController();
      const combined = AbortSignal.any(
        [signal, controller.signal].filter(Boolean)
      );
      const timer = setTimeout(
        () => controller.abort(),
        config.limits.subprocessTimeoutMs ?? 15_000
      );
      try {
        let value;
        const args = invocation.arguments;
        // Explicit dispatch only: model strings never index arbitrary functions.
        switch (invocation.tool) {
          case 'filesystem.findFiles':
            value = await cancellable(
              () =>
                capabilities
                  .get('filesystem.findFiles')
                  .invoke({ signal: combined, limit: invocation.bounds.limit }),
              combined
            );
            return {
              status: 'success',
              paths: value,
              pathCount: value.length + (value.omittedCount ?? 0),
              truncated: Boolean(value.truncated),
            };
          case 'filesystem.searchText':
            value = await cancellable(
              () =>
                capabilities.get('filesystem.searchText').invoke({
                  pattern: args.pattern,
                  signal: combined,
                  maxMatches: invocation.bounds.maxMatches,
                }),
              combined
            );
            return {
              status: 'success',
              records: value,
              recordCount: value.length + (value.omittedCount ?? 0),
              truncated: Boolean(value.truncated),
            };
          case 'filesystem.readTextFile':
            value = await cancellable(
              () =>
                capabilities.get('filesystem.readTextFile').invoke({
                  path: args.path,
                  signal: combined,
                  maxBytes: invocation.bounds.maxBytes,
                }),
              combined
            );
            return { status: 'success', records: [value] };
          default:
            throw new HarnessError(
              'E_INVESTIGATION_ACTION_INVALID',
              'Unknown investigation tool.'
            );
        }
      } catch (error) {
        checkAbort(signal);
        const code = controller.signal.aborted
          ? 'E_SUBPROCESS_TIMEOUT'
          : error?.code;
        if (!SAFE_TOOL_ERRORS.has(code)) throw error;
        return { status: 'error', error: { code } };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
