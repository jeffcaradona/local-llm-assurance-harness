export function renderReviewReport({
  format,
  review,
  request,
  includedEvidenceIds,
  omittedEvidenceIds,
  runId,
  investigation,
}) {
  const payload = {
    runId,
    request,
    includedEvidenceIds,
    omittedEvidenceIds,
    review,
    ...(investigation === undefined ? {} : { investigation }),
  };

  if (format === 'json') {
    return JSON.stringify(payload, null, 2);
  }

  const findings = review.findings.length
    ? review.findings
        .map(
          (item, idx) =>
            `${idx + 1}. [${item.severity}] ${item.category}\n   ${item.explanation}\n   consequence: ${item.consequence}\n   recommendation: ${item.recommendation}\n   evidence: ${item.evidenceIds.join(', ')}`
        )
        .join('\n')
    : 'No findings in supplied evidence.';

  return [
    `Run: ${runId}`,
    `Decision: ${review.decision}`,
    `Summary: ${review.summary}`,
    `Included evidence: ${includedEvidenceIds.join(', ') || 'none'}`,
    `Omitted evidence: ${omittedEvidenceIds.join(', ') || 'none'}`,
    ...(investigation
      ? renderInvestigationStatus(investigation, omittedEvidenceIds, review)
      : []),
    '',
    'Findings:',
    findings,
  ].join('\n');
}

function renderInvestigationStatus(investigation, omittedEvidenceIds, review) {
  const turns = investigation.turns ?? [];
  const truncatedResults = turns.filter((turn) => turn.truncated).length;
  const omittedRecords = turns.reduce(
    (total, turn) => total + (turn.omittedCount ?? 0),
    0
  );
  const omittedIds = [
    ...new Set([
      ...omittedEvidenceIds,
      ...(investigation.omittedEvidenceIds ?? []),
    ]),
  ];
  const limitations = [...investigation.limitations];
  if (truncatedResults)
    limitations.push(`Truncated collection results: ${truncatedResults}`);
  if (omittedRecords)
    limitations.push(`Omitted evidence records: ${omittedRecords}`);
  if (omittedIds.length)
    limitations.push(`Omitted evidence IDs: ${omittedIds.join(', ')}`);
  const limited = investigation.budgetForced || limitations.length > 0;
  return [
    '',
    `Investigation: valid review produced${limited ? ' with limited evidence' : ''}.`,
    `Budget-forced finalization: ${investigation.budgetForced ? 'yes' : 'no'}`,
    `Stop reason: ${investigation.stopReason}`,
    `Calls: model ${investigation.modelCalls}, tool ${investigation.toolCalls}`,
    `Elapsed: ${investigation.elapsedMs} ms`,
    `Collection limitations (harness): ${limitations.join('; ') || 'none recorded'}`,
    'Review limitation notes (model):',
    ...(review.limitations.notes.length
      ? review.limitations.notes.map((note) => `- ${note}`)
      : ['- none supplied']),
  ];
}
