import { readFile } from 'node:fs/promises';
import { HarnessError } from '../errors.js';
import {
  validateReviewPayload,
  verifyEvidenceReferences,
} from '../review/validator.js';
import { renderReviewReport } from '../reporting/render.js';
import { compilePromptContext } from '../context/compiler.js';

export function createReplayOrchestrator() {
  return {
    async replay({ bundlePath, format = 'terminal' }) {
      const raw = await readFile(bundlePath, 'utf8');
      const bundle = JSON.parse(raw);

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
