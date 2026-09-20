import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReviewReport } from '../src/reporting/render.js';

function report(overrides = {}) {
  return {
    format: 'terminal',
    runId: 'test-run',
    request: 'Review cancellation.',
    includedEvidenceIds: ['ev-0001'],
    omittedEvidenceIds: [],
    review: {
      schemaVersion: '1.0.0',
      summary: 'No issues found.',
      decision: 'no_findings_in_supplied_evidence',
      findings: [],
      observations: [],
      inferences: [],
      limitations: { notes: [], omittedEvidenceIds: [] },
    },
    ...overrides,
  };
}

function investigation(overrides = {}) {
  return {
    mode: 'investigation',
    modelCalls: 2,
    toolCalls: 1,
    elapsedMs: 123,
    budgetForced: false,
    stopReason: 'final',
    limitations: [],
    omittedEvidenceIds: [],
    turns: [],
    ...overrides,
  };
}

test('terminal shows budget-forced valid review independently of model notes', () => {
  const output = renderReviewReport(
    report({
      investigation: investigation({
        budgetForced: true,
        stopReason: 'tool_budget',
        limitations: ['tool_budget'],
      }),
    })
  );
  assert.match(output, /valid review produced with limited evidence/);
  assert.match(output, /Budget-forced finalization: yes/);
  assert.match(output, /Stop reason: tool_budget/);
  assert.match(output, /Calls: model 2, tool 1/);
  assert.match(output, /Elapsed: 123 ms/);
  assert.match(output, /Collection limitations \(harness\): tool_budget/);
  assert.match(output, /Review limitation notes \(model\):\n- none supplied/);
  assert.match(output, /No findings in supplied evidence/);
  assert.doesNotMatch(output, /failed|execution failure/i);
});

test('terminal retains truncation and omission notices without model disclosure', () => {
  const output = renderReviewReport(
    report({
      omittedEvidenceIds: ['ev-0002'],
      investigation: investigation({
        limitations: ['truncated_evidence', 'context_budget'],
        omittedEvidenceIds: ['ev-0002'],
        turns: [
          { kind: 'seed', truncated: true, omittedCount: 1 },
          { kind: 'tool', truncated: true, omittedCount: 2 },
          { kind: 'model' },
        ],
      }),
    })
  );
  assert.match(output, /valid review produced with limited evidence/);
  assert.match(output, /truncated_evidence/);
  assert.match(output, /context_budget/);
  assert.match(output, /Truncated collection results: 2/);
  assert.match(output, /Omitted evidence records: 3/);
  assert.match(output, /Omitted evidence IDs: ev-0002/);
});

test('terminal uses omission metadata even without a collection limitation code', () => {
  const output = renderReviewReport(
    report({
      investigation: investigation({ omittedEvidenceIds: ['ev-0003'] }),
    })
  );
  assert.match(output, /valid review produced with limited evidence/);
  assert.match(output, /Omitted evidence IDs: ev-0003/);
});

test('terminal shows model limitation notes separately from harness limits', () => {
  const input = report({ investigation: investigation() });
  input.review.limitations.notes = [
    'Only one caller was supplied.',
    'Runtime cancellation was not exercised.',
  ];
  const output = renderReviewReport(input);
  assert.match(
    output,
    /Review limitation notes \(model\):\n- Only one caller was supplied\.\n- Runtime cancellation was not exercised\./
  );
  assert.match(output, /Collection limitations \(harness\): none recorded/);
});

test('normal investigation completion reports counts without claiming full coverage', () => {
  const output = renderReviewReport(report({ investigation: investigation() }));
  assert.match(output, /Investigation: valid review produced\./);
  assert.match(output, /Budget-forced finalization: no/);
  assert.match(output, /Stop reason: final/);
  assert.match(output, /Calls: model 2, tool 1/);
  assert.doesNotMatch(
    output,
    /with limited evidence|complete coverage|repository safe/
  );
});

test('ordinary terminal review retains its existing output sections', () => {
  const input = report();
  input.review.limitations.notes = ['Ordinary review note.'];
  const output = renderReviewReport(input);
  assert.match(output, /Run: test-run/);
  assert.match(output, /Summary: No issues found\./);
  assert.match(output, /Included evidence: ev-0001/);
  assert.match(output, /Omitted evidence: none/);
  assert.match(output, /Findings:\nNo findings in supplied evidence\./);
  assert.doesNotMatch(
    output,
    /Investigation:|Budget-forced|Calls:|Elapsed:|limitation notes|Ordinary review note/
  );
});

test('JSON output remains a parseable unchanged report payload', () => {
  const input = report({
    format: 'json',
    investigation: investigation({
      budgetForced: true,
      stopReason: 'tool_budget',
    }),
  });
  assert.deepEqual(JSON.parse(renderReviewReport(input)), {
    runId: input.runId,
    request: input.request,
    includedEvidenceIds: input.includedEvidenceIds,
    omittedEvidenceIds: input.omittedEvidenceIds,
    review: input.review,
    investigation: input.investigation,
  });
});
