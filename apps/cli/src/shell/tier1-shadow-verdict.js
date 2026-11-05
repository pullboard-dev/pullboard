/** Derive a report-only Tier 1 verdict from the submitted gate and this review's exact frozen check. */
export function tier1ShadowFact(events, check, realVerdict, head) {
  if (!['ACCEPT', 'REJECT'].includes(realVerdict) || !['pass', 'red'].includes(check?.state)) return null;
  const submission = events.findLast(event => event.event_kind === 'submit');
  if (!submission) return null;
  let detail;
  try { detail = JSON.parse(submission.event_detail); } catch { return null; }
  if (detail.gateGreen !== true || detail.commit !== head) return null;
  const proof = detail.submissionProof;
  if (!proof || !Array.isArray(proof.files) || proof.deferred === true && proof.files.length === 0) return null;
  const tier1 = check.state === 'pass' ? 'ACCEPT' : 'REJECT';
  return `Tier-1 shadow verdict at ${head.slice(0, 12)}: ${tier1}; real reviewer verdict: ${realVerdict}. Basis: the source-matched submission gate recorded gateGreen=true (changed-file static checks and reachable tests passed), and the independent review recorded the frozen check as ${check.state}. This report does not alter the real verdict.`;
}
