import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { HarnessError, asHarnessError } from '../errors.js';
import { compilePromptContext } from '../context/compiler.js';
import {
  validateReviewPayload,
  verifyEvidenceReferences,
} from '../review/validator.js';
import { renderReviewReport } from '../reporting/render.js';
import { persistRunArtifacts } from '../audit/manifest.js';
import { REVIEW_SCHEMA_VERSION } from '../review/schema.js';
import { createRedactor } from '../redaction.js';
import { runInvestigation } from './investigationLoop.js';
import { withCancellation as cancellable } from '../lifecycle/cancellation.js';

function makeEvidenceId(index) {
  return `ev-${String(index + 1).padStart(4, '0')}`;
}

function withEvidenceMeta(record, capability, index, collectedAt) {
  return {
    id: makeEvidenceId(index),
    capability,
    sourcePath: record.relativePath,
    lineRange: record.lineStart ? [record.lineStart, record.lineEnd] : null,
    content: record.content,
    collectedAt,
    retainedBytes: record.retainedBytes,
    originalBytes: record.originalBytes,
    truncated: record.truncated,
    redaction: record.redaction,
  };
}

const AUTO_DISCOVERY_SKIPPABLE_CODES = new Set([
  'E_SENSITIVE_PATH_BLOCKED',
  'E_BINARY_FILE_REJECTED',
  'E_SYMLINK_BLOCKED',
]);

function checkInvestigationAbort(signal) {
  if (!signal.aborted) return;
  throw new HarnessError(
    signal.reason?.code === 'E_INVESTIGATION_TIMEOUT'
      ? 'E_INVESTIGATION_TIMEOUT'
      : 'E_ABORTED',
    'Investigation cancelled before finalization.'
  );
}

export function createReviewOrchestrator({
  config,
  capabilities,
  provider,
  admission,
  lifecycle,
  redactor = createRedactor(),
  persistArtifacts = persistRunArtifacts,
}) {
  return {
    async review({
      rootPath,
      selectedFiles = [],
      searches = [],
      request,
      format = 'terminal',
      instructionFiles = [],
      includeReplay = false,
      investigate = false,
      onProgress,
      signal,
    }) {
      if (!request) {
        throw new HarnessError(
          'E_REVIEW_REQUEST_REQUIRED',
          'Review request text is required.'
        );
      }

      let scope;
      let acquired = false;
      let deadlineTimer;
      let startedAt;
      let activeSignal;
      let investigation;
      let stage = 'admission';
      const runId = randomUUID();

      try {
        scope = lifecycle.createRequestScope();
        const requestSignal = AbortSignal.any(
          [signal, scope.signal].filter(Boolean)
        );
        await admission.acquire(requestSignal);
        acquired = true;
        startedAt = Date.now();
        const deadlineController = investigate
          ? new AbortController()
          : undefined;
        if (deadlineController) {
          deadlineTimer = setTimeout(() => {
            deadlineController.abort(
              new HarnessError(
                'E_INVESTIGATION_TIMEOUT',
                'Investigation deadline exceeded.'
              )
            );
          }, config.investigation.timeoutMs);
        }
        const reviewRoot = resolve(rootPath);
        activeSignal = AbortSignal.any(
          [requestSignal, deadlineController?.signal].filter(Boolean)
        );
        let evidence;
        let context;
        let review;
        let investigationReplayBundle;
        if (investigate) {
          stage = 'root';
          checkInvestigationAbort(activeSignal);
          let validRoot = false;
          try {
            validRoot = (await stat(reviewRoot)).isDirectory();
          } catch {
            // Filesystem errors may disclose the private repository path.
          }
          checkInvestigationAbort(activeSignal);
          if (!validRoot) {
            throw new HarnessError(
              'E_REVIEW_ROOT_INVALID',
              'Investigation root must be an accessible existing directory.'
            );
          }
          stage = 'instructions';
          ({
            evidence,
            context,
            review,
            investigation,
            replayBundle: investigationReplayBundle,
          } = await runInvestigation({
            config,
            capabilities,
            provider,
            redactor,
            request,
            selectedFiles,
            searches,
            instructionFiles,
            signal: activeSignal,
            onProgress,
            startedAt,
          }));
        } else {
          const collectedAt = new Date().toISOString();
          const findFiles = capabilities.get('filesystem.findFiles');
          const readTextFile = capabilities.get('filesystem.readTextFile');
          const searchText = capabilities.get('filesystem.searchText');
          evidence = [];
          let totalBytes = 0;
          const explicitFileSelection = selectedFiles.length > 0;

          const fileList = selectedFiles.length
            ? [...new Set(selectedFiles)].sort()
            : await findFiles.invoke({
                signal: activeSignal,
                limit: config.limits.maxFiles,
              });

          for (const file of fileList) {
            if (totalBytes >= config.limits.maxEvidenceBytes) break;
            let record;
            try {
              record = await readTextFile.invoke({
                path: file,
                signal: activeSignal,
                maxBytes: config.limits.maxFileBytes,
              });
            } catch (error) {
              if (
                !explicitFileSelection &&
                AUTO_DISCOVERY_SKIPPABLE_CODES.has(error?.code)
              ) {
                continue;
              }
              throw error;
            }
            const item = withEvidenceMeta(
              record,
              'filesystem.readTextFile',
              evidence.length,
              collectedAt
            );
            if (
              totalBytes + item.retainedBytes >
              config.limits.maxEvidenceBytes
            )
              break;
            evidence.push(item);
            totalBytes += item.retainedBytes;
          }

          for (const pattern of searches) {
            if (totalBytes >= config.limits.maxEvidenceBytes) break;
            const records = await searchText.invoke({
              pattern,
              signal: activeSignal,
              maxMatches: config.limits.maxSearchMatches,
            });
            for (const record of records) {
              const item = withEvidenceMeta(
                record,
                'filesystem.searchText',
                evidence.length,
                collectedAt
              );
              if (
                totalBytes + item.retainedBytes >
                config.limits.maxEvidenceBytes
              )
                break;
              evidence.push(item);
              totalBytes += item.retainedBytes;
            }
          }

          context = await compilePromptContext({
            request,
            evidence,
            instructionFiles,
            maxChars: config.model.maxPromptChars,
            signal: activeSignal,
          });

          review = await provider.complete({
            systemPrompt: context.systemPrompt,
            userPrompt: context.userPrompt,
            responseSchema: context.responseSchema,
            signal: activeSignal,
          });
        }

        if (investigate) checkInvestigationAbort(activeSignal);
        stage = 'validation';
        validateReviewPayload(review);
        verifyEvidenceReferences(
          review,
          context.includedEvidenceIds,
          context.omittedEvidenceIds
        );

        stage = 'report';
        const reportText = renderReviewReport({
          format,
          review,
          request: investigate ? redactor.redact(request) : request,
          includedEvidenceIds: context.includedEvidenceIds,
          omittedEvidenceIds: context.omittedEvidenceIds,
          runId,
          investigation,
        });

        const manifest = {
          runId,
          createdAt: new Date().toISOString(),
          rootPath: investigate ? redactor.redact(reviewRoot) : reviewRoot,
          ...(investigate ? { investigation } : { request }),
          status: 'success',
          decision: review.decision,
          schemaVersion: REVIEW_SCHEMA_VERSION,
          format,
          evidenceSummary: evidence.map((item) => ({
            id: item.id,
            capability: item.capability,
            sourcePath: investigate
              ? redactor.redact(item.sourcePath)
              : item.sourcePath,
            lineRange: item.lineRange,
            retainedBytes: item.retainedBytes,
            originalBytes: item.originalBytes,
            truncated: item.truncated,
            redaction: item.redaction,
          })),
          includedEvidenceIds: context.includedEvidenceIds,
          omittedEvidenceIds: context.omittedEvidenceIds,
        };

        const replayBundle = includeReplay
          ? investigate
            ? { ...investigationReplayBundle, runId }
            : {
                runId,
                request,
                evidence,
                trustedInstructions: context.trustedInstructions,
                maxPromptChars: config.model.maxPromptChars,
                systemPrompt: context.systemPrompt,
                userPrompt: context.userPrompt,
                includedEvidenceIds: context.includedEvidenceIds,
                omittedEvidenceIds: context.omittedEvidenceIds,
                review,
              }
          : undefined;

        if (investigate) checkInvestigationAbort(activeSignal);
        stage = 'artifacts';
        const paths = await cancellable(
          () =>
            persistArtifacts({
              outputDir: config.review.outputDir,
              reviewedRoot: reviewRoot,
              runId,
              manifest,
              replayBundle,
              signal: activeSignal,
            }),
          activeSignal
        );

        return {
          runId,
          reportText,
          manifestPath: paths.manifestPath,
          replayPath: paths.replayPath,
          ...(investigate ? { investigation } : {}),
        };
      } catch (error) {
        if (investigate) {
          const code = activeSignal?.aborted
            ? activeSignal.reason?.code === 'E_INVESTIGATION_TIMEOUT'
              ? 'E_INVESTIGATION_TIMEOUT'
              : 'E_ABORTED'
            : error instanceof HarnessError
              ? error.code
              : 'E_INTERNAL';
          if (error instanceof HarnessError && error.details?.investigation) {
            throw error;
          }
          throw new HarnessError(
            code,
            'Investigation ended without completing the review run.',
            {
              stage,
              investigation: {
                mode: 'investigation',
                modelCalls: 0,
                toolCalls: 0,
                seedCalls: 0,
                budgetForced: false,
                limitations: [],
                collectedEvidenceIds: [],
                omittedEvidenceIds: [],
                turns: [],
                ...investigation,
                elapsedMs:
                  startedAt === undefined
                    ? 0
                    : Math.max(0, Date.now() - startedAt),
                stopReason: code,
              },
            }
          );
        }
        throw asHarnessError(error);
      } finally {
        clearTimeout(deadlineTimer);
        scope?.done();
        if (acquired) admission.release();
      }
    },
  };
}
