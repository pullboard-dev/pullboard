import { createHash } from 'node:crypto';
import { phaseReceiptId } from '../../../jobs/index.js';
import { readPayload } from '../../../jobs/index.js';
import { offeredRequest } from './jobs.js';
import { reusePlanDigest } from '../logic/gate/reuse-plan.js';

const FILE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\n\r]{1,4096}$/u;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const files = value => Array.isArray(value) && value.every(file => typeof file === 'string' && FILE.test(file));
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * Carry each accepted member's complete obligations, independently of the flat pass ledger [C7,#12971].
 * Only the native accepted submit and its admission-linked phase receipts authorize a finite scope. Legacy or
 * incomplete evidence stays explicitly unknown; the consumer must retain the conservative combined plan for it.
 */
export function landingMembers(db, items, { runs = null } = {}) {
  return items.map(member => {
    try { return memberScope(db, member, runs); }
    catch { return { item: member.id, commit: member.commit, status: 'unknown', reason: 'accepted obligation evidence unavailable' }; }
  });
}

/** Read one member's accepted source and native proof, never infer obligations from successful result rows. */
function memberScope(db, member, runs) {
  const unknown = reason => ({ item: member.id, commit: member.commit, status: 'unknown', reason });
  const item = db.prepare('SELECT * FROM item WHERE item_id = ?').get(member.id);
  if (!item || !['verified', 'merged'].includes(item.item_status) || item.item_verdict !== 'ACCEPT' || item.item_commit !== member.commit) return unknown('member is not accepted at this commit');
  const rows = db.prepare('SELECT * FROM event WHERE item_id = ? ORDER BY event_id').all(member.id);
  const detail = row => row ? JSON.parse(row.event_detail) : null;
  const submission = rows.findLast(row => row.event_kind === 'submit');
  const accepted = rows.findLast(row => row.event_kind === 'accept');
  const submitted = detail(submission), proof = submitted?.submissionProof;
  const frozen = JSON.parse(item.item_frozen);
  if (!accepted || accepted.event_id <= submission?.event_id || detail(accepted).commit !== member.commit
    || submitted?.commit !== member.commit || submitted.tree !== item.item_tree || !SHA.test(submitted.tree)
    || !SHA.test(submitted.policyCommit) || submitted.criterionDigest !== item.item_frozen_digest
    || createHash('sha256').update(item.item_frozen).digest('hex') !== item.item_frozen_digest
    || submitted.gateGreen !== true || submitted.companion || proof?.version !== 1 || proof.full !== false
    || proof.knownMainFailures || proof.knownMainAmbiguous || !files(proof.files)
    || typeof proof.deferred !== 'boolean' || (proof.deferred && !files(proof.deferredFiles))
    || (proof.owedFiles !== undefined && !files(proof.owedFiles))) return unknown('accepted submit has no complete finite plan');
  const admissionEvent = rows.findLast(row => row.event_id < submission.event_id && row.event_by === submission.event_by
    && ['claim', 'renew'].includes(row.event_kind) && detail(row).submitAdmission);
  const admission = detail(admissionEvent)?.submitAdmission;
  if (!admission || admission.commit !== member.commit || admission.tree !== item.item_tree) return unknown('submit admission does not bind accepted source');
  const receipts = rows.filter(row => row.event_id > admissionEvent.event_id && row.event_id < submission.event_id
    && row.event_by === submission.event_by && row.event_kind === 'proof-run').map(row => detail(row).receipt)
    .filter(run => run?.submitReuse === true && run.submitAdmission === admission.id);
  const settled = rows.filter(row => row.event_kind === 'gate_settled' && row.event_id > submission.event_id
    && row.event_id < accepted.event_id && detail(row).outcome === 'green' && detail(row).class === 'item');
  const matches = [];
  for (const event of settled) {
    const job = detail(event).job, home = runs?.db ?? db;
    const offered = home.prepare('SELECT job_kind, job_item, job_candidate, job_base FROM job WHERE job_id = ?').get(job);
    if (offered?.job_kind !== 'gate' || offered.job_item !== member.id || offered.job_candidate !== member.commit || offered.job_base !== submitted.policyCommit) continue;
    const request = offeredRequest(db, job, { runs });
    const source = request?.submit;
    if (source?.agentId !== submission.event_by || source.digest !== item.item_frozen_digest || source.tree !== item.item_tree
      || source.companion || source.tooling !== submitted.tooling) continue;
    // Read only the native final receipt. Progress, artifacts and unrelated steps are not scope authority.
    const posted = home.prepare("SELECT job_step_payload FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt' ORDER BY job_step_seq DESC LIMIT 1").get(job);
    const kept = posted ? readPayload(home, posted.job_step_payload)?.receipt : null;
    const analysis = kept?.gate?.analysis;
    const check = request?.input?.data?.check ?? '';
    if (typeof check !== 'string' || !files(analysis?.proofFiles) || !same(analysis.proofFiles, proof.files)
      || typeof analysis.proofCommand !== 'string') continue;
    const digest = reusePlanDigest({ check, files: proof.files, full: false, deferred: proof.deferred, proofCommand: analysis.proofCommand });
    const phases = [['check', 'criterion', check], ['proof', 'proof', analysis.proofCommand]].filter(([, , command]) => command);
    const ids = [];
    for (const [role, phase, command] of phases) {
      const found = receipts.filter(run => run.submitPhase === phase && run.command === createHash('sha256').update(command).digest('hex'));
      if (found.length !== 1) break;
      const run = found[0];
      if (run.id !== phaseReceiptId(job, role) || run.kind !== 'submit' || run.item !== member.id || run.seat !== submission.event_by
        || run.commit !== member.commit || run.tree !== item.item_tree || run.main !== submitted.policyCommit
        || run.frozenDigest !== item.item_frozen_digest || run.submitReusePlan !== digest || run.sourceClean !== true
        || run.green !== true || run.exitCode !== 0 || run.blockingVerdict) break;
      ids.push(run.id);
    }
    if (!phases.length || ids.length !== phases.length) continue;
    const named = Object.keys(frozen.testHashes ?? {});
    if (!files(named)) continue;
    matches.push({ version: 1, status: 'complete', item: member.id, commit: member.commit, tree: item.item_tree,
      policyCommit: submitted.policyCommit, claimBase: source.claimBase ?? null, tooling: submitted.tooling ?? null,
      frozenDigest: item.item_frozen_digest, frozen, check,
      selection: { files: proof.files, full: false, deferred: proof.deferred, deferredFiles: proof.deferredFiles ?? [], owedFiles: proof.owedFiles ?? [], proofCommand: analysis.proofCommand },
      required: [...new Set([...proof.files, ...named, ...(proof.deferredFiles ?? []), ...(proof.owedFiles ?? [])])].sort(),
      provenance: { submit: submission.event_id, accept: accepted.event_id, admission: admission.id, job, receipts: ids } });
  }
  return matches.length === 1 ? matches[0] : unknown('native accepted obligation proof missing or ambiguous');
}
