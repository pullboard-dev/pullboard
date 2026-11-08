import { submitReusePlanDigest } from '../core/submit-reuse-plan.js';
import { createHash } from 'node:crypto';

/** The main commit the last submission was gated against, or null without one [C7]. */
export function submittedPolicyCommit(events) {
  const submission = [...events].sort((a, b) => a.event_id - b.event_id).findLast(row => row.event_kind === 'submit');
  try { return submission ? JSON.parse(submission.event_detail).policyCommit ?? null : null; } catch { return null; }
}

/**
 * Accept only both origin-sealed submit phases from the exact admission and source [C7,H16]. The key is the candidate
 * tree, the composed main and, when the caller names one, the tooling tree (RFC 0007 SC7): a submit that recorded other
 * tooling, or none, is never reused. With `allowDeferred` a deferred full suite does not refuse a sealed receipt (#2939).
 *
 * @param {object[]} events - The item's board events.
 * @param {{ item: object, commit: string, tree: string, main: string, tooling?: string | null, check: string,
 *   affectedTests: string, gate: string, supplement?: string, expectedPlan?: object, allowDeferred?: boolean }} input
 * @returns {{ ids: string[], environment: object | null } | { reason: string }} The reused receipt ids, or why not.
 */
export function reusableSubmitProof(events, { item, commit, tree, main, tooling, check, affectedTests, gate, supplement, expectedPlan, allowDeferred = false }) {
  const rows = [...events].sort((a, b) => a.event_id - b.event_id);
  const submission = rows.findLast(row => row.event_kind === 'submit');
  if (!submission) return { reason: 'no recorded submission' };
  const detail = JSON.parse(submission.event_detail);
  if (detail.commit !== commit || detail.tree !== tree) return { reason: 'commit or tree changed' };
  if (detail.policyCommit !== main) return { reason: 'composed main changed' };
  if (tooling !== undefined && (!tooling || detail.tooling !== tooling)) return { reason: 'tooling tree changed' };
  if (detail.criterionDigest !== item.item_frozen_digest) return { reason: 'frozen criterion changed' };
  const proof = detail.submissionProof;
  if (detail.gateGreen !== true || !proof || proof.deferred && expectedPlan?.tiered !== true && !allowDeferred || proof.knownMainFailures || detail.companion) return { reason: 'submission proof is incomplete or not green' };
  if (expectedPlan && (proof.full !== expectedPlan.full || proof.deferred !== expectedPlan.deferred
    || JSON.stringify([...proof.files].sort()) !== JSON.stringify([...expectedPlan.files].sort()))) return { reason: 'submit selection changed' };
  const admissionEvent = rows.findLast(row => row.event_id < submission.event_id && row.event_by === submission.event_by
    && ['claim', 'renew'].includes(row.event_kind) && JSON.parse(row.event_detail).submitAdmission);
  if (!admissionEvent) return { reason: 'no linked submit admission' };
  const admission = JSON.parse(admissionEvent.event_detail).submitAdmission;
  if (admission.commit !== commit || admission.tree !== tree) return { reason: 'submit admission source changed' };
  const runs = rows.filter(row => row.event_id > admissionEvent.event_id && row.event_id < submission.event_id
    && row.event_by === submission.event_by && row.event_kind === 'proof-run')
    .map(row => JSON.parse(row.event_detail).receipt).filter(run => run?.submitReuse === true && run.submitAdmission === admission.id);
  const digest = command => createHash('sha256').update(command).digest('hex');
  const word = value => `'${String(value).replaceAll("'", "'\\\\''")}'`;
  const proofCommand = expectedPlan ? expectedPlan.proofCommand : proof.full ? gate : proof.files.length ? `${affectedTests.trimEnd()} ${proof.files.map(path => word('./' + path)).join(' ')}` : '';
  if (supplement && supplement !== proofCommand) return { reason: 'selected verification tests changed' };
  const planDigest = submitReusePlanDigest({ check, files: proof.files, full: proof.full, deferred: proof.deferred, proofCommand });
  const phases = [['criterion', check], ['proof', proofCommand]].filter(([, command]) => command);
  const ids = [];
  let environment = null;
  for (const [phase, command] of phases) {
    const matches = runs.filter(run => run.submitPhase === phase && run.command === digest(command));
    if (matches.length !== 1) return { reason: `${phase} receipt missing or ambiguous` };
    const run = matches[0];
    if (run.kind !== 'submit' || run.item !== item.item_id || run.seat !== submission.event_by
      || run.commit !== commit || run.tree !== tree || run.main !== main || run.frozenDigest !== item.item_frozen_digest
      || run.submitReusePlan !== planDigest || run.sourceClean !== true || run.green !== true || run.exitCode !== 0 || run.blockingVerdict) return { reason: `${phase} receipt does not match` };
    ids.push(run.id);
    environment ??= run.environment ?? null;
  }
  if (!ids.length) return { reason: 'no executed submit proof' };
  return { ids, environment };
}
