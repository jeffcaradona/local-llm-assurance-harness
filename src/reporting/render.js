export function renderReviewReport({
  format,
  review,
  request,
  includedEvidenceIds,
  omittedEvidenceIds,
  runId,
}) {
  const payload = {
    runId,
    request,
    includedEvidenceIds,
    omittedEvidenceIds,
    review,
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
    '',
    'Findings:',
    findings,
  ].join('\n');
}
