import { atomic } from '../../io/board.js';
import { addItem } from '../../io/board.js';
import { getItem } from '../../io/board.js';
import { logEvent } from '../../io/board.js';
import { proofReceipts } from '../../io/board/query.js';
import { verdictReviewProblem } from '../../../../verify/index.js';
import { Refused } from '../../../../kernel/index.js';
import { CLAUSE_EVIDENCE_ENGINE } from '../../../../state/index.js';
import { ENGINE_VERSION } from '../../../../state/index.js';
import { PER_ITEM_FULL_SUITE_ENGINE } from '../../../../state/light.js';

/** Accept only normalized repository-relative paths from complete native test outcomes. */
function projectFile(file) {
  return typeof file === 'string' && file.length > 0 && file.length <= 4096 && !/[:\\\p{Cc}\p{Zl}\p{Zp}]/u.test(file)
    && !file.startsWith('/')
    && file.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Return the source-bound selector gap a recorded failed review proves, or null when evidence is incomplete. */
export function selectorGapCandidate(board, { agentId, itemId, receiptId, review }) {
  const item = getItem(board, itemId);
  if (item.item_status !== 'submitted' || !review || verdictReviewProblem(review, item.item_commit, { checked: true })) return null;
  const submission = board.db.prepare("SELECT event_by,event_detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1").get(itemId);
  if (!submission) return null;
  const submitted = JSON.parse(submission.event_detail);
  const selection = submitted.submissionProof;
  if (submitted.commit !== item.item_commit || submitted.criterionDigest !== item.item_frozen_digest || submitted.gateGreen !== true
    || !selection || selection.version !== 1 || selection.full !== false || selection.deferred !== false
    || selection.deferredFiles !== undefined || !Array.isArray(selection.files)) return null;
  if (agentId === submission.event_by || agentId === item.item_built_by) return null;
  const receipt = proofReceipts(board, itemId).find(row => row.id === receiptId);
  if (!receipt || receipt.kind !== 'verdict' || receipt.seat !== agentId || receipt.commit !== review.head
    || receipt.frozenDigest !== item.item_frozen_digest || receipt.sourceClean !== true || receipt.exitCode === 0
    || !Array.isArray(receipt.failures) || !receipt.failures.length || !Array.isArray(receipt.testOutcomes)) return null;
  const failures = receipt.failures;
  const failedOutcomes = receipt.testOutcomes.filter(row => row.passed === false && row.skipped !== true);
  if (receipt.counts?.failed !== failures.length || failedOutcomes.length !== failures.length
    || failures.some(failure => !projectFile(failure.file) || typeof failure.name !== 'string' || !failure.name
      || failedOutcomes.filter(row => row.file === failure.file && row.name === failure.name).length !== 1)) return null;

  // A case already run by the submit gate's required criterion phase is required evidence, even if it is
  // absent from the affected-test selection; do not recast a failed required criterion as a selector gap.
  const criterionFiles = new Set(proofReceipts(board, itemId)
    .filter(row => row.kind === 'submit' && row.commit === submitted.commit && row.submitPhase === 'criterion' && row.exitCode === 0)
    .flatMap(row => Array.isArray(row.testOutcomes) ? row.testOutcomes.map(outcome => outcome.file) : []));
  if (failures.some(failure => selection.files.includes(failure.file) || criterionFiles.has(failure.file))) return null;
  return { item, receipt, selection, failures, commit: submitted.commit, tree: item.item_tree };
}

/**
 * The repair item's bar. Why: since the clause-evidence engine every numbered clause must declare its evidence kind,
 * or the repair's addItem refuses CLAUSE_EVIDENCE_REQUIRED; older engines replay their original untagged text.
 */
function selectorRepairCriterion(board, commit, names) {
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  const tag = engine >= CLAUSE_EVIDENCE_ENGINE ? kind => ` [${kind}]` : () => '';
  // Since the per-item full-suite engine a bar cannot name the full suite: it belongs to the main audit (S10).
  const suite = engine >= PER_ITEM_FULL_SUITE_ENGINE ? '' : ` 3. The full suite passes as run by the submit gate.${tag('command')}`;
  return `At submitted source ${commit}, ${names} failed in review but was outside the gate's recorded selection. 1. Include the uncovered test in the computed gate selection.${tag('test')} 2. Prove the selection runs and reports that test at the submitted source.${tag('test')}${suite}`;
}

/** Record an uncovered failing case and file one selector repair without changing the submitted item. */
export function recordSelectorGap(board, { agentId, itemId, receiptId, review }) {
  return atomic(board, () => {
    const candidate = selectorGapCandidate(board, { agentId, itemId, receiptId, review });
    if (!candidate) throw new Refused('SELECTOR_GAP_UNPROVED', 'the failing review receipt is not an uncovered selector case; continue the ordinary review path');
    /** Give each exact submitted failure case a stable identity for replay-safe deduplication. */
    function identity(failure) { return JSON.stringify([candidate.commit, candidate.tree, candidate.item.item_frozen_digest, failure.file, failure.name]); }
    const prior = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='selector-gap' ORDER BY event_id").all(itemId)
      .map(row => JSON.parse(row.event_detail));
    const existing = new Map(prior.map(detail => [detail.identity, detail.repairItem]));
    const fresh = candidate.failures.filter(failure => !existing.has(identity(failure)));
    if (!fresh.length) return { decision: 'SELECTOR_GAP', item: existing.get(identity(candidate.failures[0])), filed: false };
    const first = fresh[0];
    const title = `Test selector gap: ${first.file.slice(-80)} at ${candidate.commit.slice(0, 12)}`;
    const names = fresh.map(failure => `${failure.file} :: ${failure.name}`).join('; ').slice(0, 1000);
    const repairItem = addItem(board, { by: agentId, lane: 'core', title, specIds: ['C7'], route: 'strong', expectedBuildMinutes: 30,
      criterion: selectorRepairCriterion(board, candidate.commit, names),
      brief: `Builder item: #${itemId}\nReview receipt: ${receiptId}\nSubmitted head: ${candidate.commit}\nSelected tests: ${candidate.selection.files.join(', ') || '(none)'}` });
    for (const failure of fresh) logEvent(board, agentId, 'selector-gap', itemId, {
      decision: 'SELECTOR_GAP', receiptId, commit: candidate.commit, tree: candidate.tree,
      frozenDigest: candidate.item.item_frozen_digest, selection: candidate.selection.files,
      failure, identity: identity(failure), repairItem,
    });
    return { decision: 'SELECTOR_GAP', item: repairItem, filed: true };
  });
}
