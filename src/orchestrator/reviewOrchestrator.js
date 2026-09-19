import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessError, asHarnessError } from '../errors.js';
import { compilePromptContext } from '../context/compiler.js';
import {
  validateReviewPayload,
  verifyEvidenceReferences,
} from '../review/validator.js';
import { renderReviewReport } from '../reporting/render.js';
import { persistRunArtifacts } from '../audit/manifest.js';
import { REVIEW_SCHEMA_VERSION } from '../review/schema.js';

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

export function createReviewOrchestrator({
  config,
  capabilities,
  provider,
  admission,
  lifecycle,
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
      signal,
    }) {
      if (!request) {
        throw new HarnessError(
          'E_REVIEW_REQUEST_REQUIRED',
          'Review request text is required.'
        );
      }

      const scope = lifecycle.createRequestScope();
      let acquired = false;
      const runId = randomUUID();

      try {
        await admission.acquire(signal);
        acquired = true;
        const reviewRoot = resolve(rootPath);
        const activeSignal = AbortSignal.any(
          [signal, scope.signal].filter(Boolean)
        );
        const collectedAt = new Date().toISOString();
        const findFiles = capabilities.get('filesystem.findFiles');
        const readTextFile = capabilities.get('filesystem.readTextFile');
        const searchText = capabilities.get('filesystem.searchText');
        const evidence = [];
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
          if (totalBytes + item.retainedBytes > config.limits.maxEvidenceBytes)
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

        const context = await compilePromptContext({
          request,
          evidence,
          instructionFiles,
          maxChars: config.model.maxPromptChars,
          signal: activeSignal,
        });

        const review = await provider.complete({
          systemPrompt: context.systemPrompt,
          userPrompt: context.userPrompt,
          responseSchema: context.responseSchema,
          signal: activeSignal,
        });

        validateReviewPayload(review);
        verifyEvidenceReferences(
          review,
          context.includedEvidenceIds,
          context.omittedEvidenceIds
        );

        const reportText = renderReviewReport({
          format,
          review,
          request,
          includedEvidenceIds: context.includedEvidenceIds,
          omittedEvidenceIds: context.omittedEvidenceIds,
          runId,
        });

        const manifest = {
          runId,
          createdAt: new Date().toISOString(),
          rootPath: reviewRoot,
          request,
          status: 'success',
          decision: review.decision,
          schemaVersion: REVIEW_SCHEMA_VERSION,
          format,
          evidenceSummary: evidence.map((item) => ({
            id: item.id,
            capability: item.capability,
            sourcePath: item.sourcePath,
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
          ? {
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

        const paths = await persistRunArtifacts({
          outputDir: config.review.outputDir,
          reviewedRoot: reviewRoot,
          runId,
          manifest,
          replayBundle,
        });

        return {
          runId,
          reportText,
          manifestPath: paths.manifestPath,
          replayPath: paths.replayPath,
        };
      } catch (error) {
        throw asHarnessError(error);
      } finally {
        scope.done();
        if (acquired) admission.release();
      }
    },
  };
}
