/**
 * Settle a queued accept from its check job's receipt: a green check records the reviewer's accept, a red one reopens
 * the item to its builder with the failing reason. The reviewer's seat is not waiting on the check, so the board's own
 * receipt path writes the verdict the seat would have written had it waited [C7,V4,#3161].
 */
import { writeStep } from '../../../../jobs/index.js';
import { captureVerdictReview } from '../../../../verify/index.js';
import { frozenBar } from '../../../../verify/index.js';
import * as boardStore from '../../../../store/index.js';

/** The step on the review job that names the check job a queued accept is waiting on (the CLI writes it). */
const QUEUED = 'accept-queued';
/** The step this settlement writes once, so a second receipt for the same job changes nothing. */
const SETTLED = 'accept-settled';

/** The first line of a failing check's output that says what failed, shortened for a verdict note. */
function failingReason(receipt) {
  const gate = receipt?.gate ?? {};
  const phase = gate.phases?.[0] ?? {};
  const named = (phase.failures ?? []).map(row => `${row.file}: ${row.name}`).slice(0, 5).join('; ');
  const text = named || String(phase.tail ?? gate.error ?? receipt?.tail ?? '').trim().split('\n').filter(Boolean).slice(-6).join(' | ');
  return (text || `the check exited ${receipt?.status ?? 'non-zero'}`).slice(0, 600);
}

/** The frozen criterion a red check rejects against: the whole criterion, or its first sentence when that is too long to quote. */
function failingClause(item) {
  const { criterion } = frozenBar(item);
  return criterion.length <= 4096 ? criterion : criterion.split(/(?<=[.!?])\s+/u)[0].slice(0, 4096);
}

/**
 * Record the verdict a queued accept is waiting on, when the posted receipt is its check job's.
 *
 * @param {any} board
 * @param {{ job: string, receipt: Record<string, any> }} posted
 * @returns {{ applied: boolean, outcome: string, decision?: string }} outcome: `none` when no accept waits on this job.
 */
export function settleQueuedAccept(board, posted) {
  const row = board.db.prepare(`SELECT job_step_job AS review, job_step_payload AS payload FROM job_step
    WHERE job_step_name = ? AND json_extract(job_step_payload, '$.checkJob') = ? ORDER BY job_step_id DESC LIMIT 1`).get(QUEUED, posted.job);
  if (!row) return { applied: false, outcome: 'none' };
  const queued = JSON.parse(row.payload);
  const item = Number(String(row.review).split(':')[1]);
  const settled = board.db.prepare('SELECT 1 FROM job_step WHERE job_step_job = ? AND job_step_name = ? AND job_step_id > (SELECT MAX(job_step_id) FROM job_step WHERE job_step_job = ? AND job_step_name = ?)')
    .get(row.review, SETTLED, row.review, QUEUED);
  if (settled) return { applied: false, outcome: 'settled' };
  const found = boardStore.getItem(board, item);
  if (!found || found.item_status !== 'submitted' || found.item_commit !== queued.commit) {
    writeStep(board.db, row.review, SETTLED, { checkJob: posted.job, decision: 'STALE' });
    return { applied: false, outcome: 'stale' };
  }
  const gate = posted.receipt?.gate ?? {};
  const green = posted.receipt?.status === 0 && gate.green === true && gate.phases?.[0]?.status === 0;
  const decision = green ? 'ACCEPT' : 'REJECT';
  const review = board.gitRoot ? captureVerdictReview(board.gitRoot, board, found, queued.main, queued.commit, { events: boardStore.events }) : undefined;
  boardStore.verify(board, item, {
    agentId: queued.reviewer,
    decision,
    ...(green ? {} : { reason: 'TEST_FAILURE', clause: failingClause(found) }),
    note: green ? `the frozen check passed as queued runner job ${posted.job}`
      : `the frozen check failed as queued runner job ${posted.job}: ${failingReason(posted.receipt)}`,
    head: queued.commit,
    digest: queued.digest,
    policy: queued.policy ?? 'any',
    familyPolicy: queued.family ?? 'off',
    ...(review ? { review } : {}),
    ...(green ? { check: 'green' } : {}),
  });
  writeStep(board.db, row.review, SETTLED, { checkJob: posted.job, decision });
  return { applied: true, outcome: 'accept-settled', decision };
}
