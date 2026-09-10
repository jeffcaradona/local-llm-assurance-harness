import { readFile } from 'node:fs/promises';
import { HarnessError } from '../errors.js';
import { validateReviewPayload, verifyEvidenceReferences } from '../review/validator.js';
import { renderReviewReport } from '../reporting/render.js';

export function createReplayOrchestrator() {
  return {
    async replay({ bundlePath, format = 'terminal' }) {
      const raw = await readFile(bundlePath, 'utf8');
      const bundle = JSON.parse(raw);

      if (!bundle?.review || !bundle?.includedEvidenceIds) {
        throw new HarnessError('E_REPLAY_UNSUPPORTED', 'Replay bundle did not include review artifacts.');
      }

      validateReviewPayload(bundle.review);
      verifyEvidenceReferences(bundle.review, bundle.includedEvidenceIds);

      return renderReviewReport({
        format,
        review: bundle.review,
        request: 'Replay run',
        includedEvidenceIds: bundle.includedEvidenceIds,
        omittedEvidenceIds: bundle.omittedEvidenceIds ?? [],
        runId: bundle.runId ?? 'replay'
      });
    }
  };
}
