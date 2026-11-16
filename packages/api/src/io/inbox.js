/** The receipt inbox as the gate reads it while runs_store is on: each receipt in the runs file is applied once per attempt [B2,P7]. */
import { applyRunReceipt } from '../../../store/index.js';
import { jobView } from '../../../jobs/index.js';
import { boardRun } from '../../../store/index.js';
import { applyJobReceipt } from './gate.js';

/**
 * Apply every receipt the runs inbox holds, each once: the receipt is read from the runs file before the board write
 * opens, then one board move checks the run row is still queued for an older attempt, records its outcome and summary,
 * and runs the same applier a posted receipt reaches; the receipt is acked afterwards. A receipt already applied, or
 * one for an older attempt, changes nothing but its ack.
 * Why: SQLite commits no two files together, so a crash between the move and the ack leaves the receipt in the inbox,
 * and the repeat is a no-op (~/pbseat/coord/runner-store-design.md, section 2).
 *
 * @param {any} board
 * @param {NonNullable<ReturnType<typeof import('./queue.js').queueFor>>} queue
 * @param {Parameters<typeof applyJobReceipt>[2]} [ports] - The applier's ports, as applyJobReceipt takes them.
 * @param {{ limit?: number }} [options]
 * @returns {{ job: string, attempt: number, applied: boolean, outcome?: string }[]}
 */
export function applyInbox(board, queue, ports = {}, { limit = 100 } = {}) {
  return queue.port.receiptsSince(0, { limit }).map(({ job, attempt }) => {
    const receipt = jobView(queue.runs.db, job)?.steps.find(row => row.name === 'receipt' && row.seq === attempt)?.payload?.receipt ?? {};
    // The appliers do file I/O (landing logs, test records), so they run outside a board write: the run row is checked first, the receipt applied, then the row settles. A crash between leaves the run queued and the repeat applies again, as a posted receipt would.
    const run = boardRun(board.db, job);
    const fresh = run?.run_state === 'queued' && attempt > run.run_attempt;
    const answer = fresh ? applyJobReceipt(board, { job, attempt, receipt }, { ...ports, queue }) : { applied: false, outcome: 'already-applied' };
    if (fresh) applyRunReceipt(board, { by: queue.by, job, attempt, outcome: String(receipt.outcome ?? receipt.status ?? 'unknown'), summary: receipt });
    queue.port.ack(job, attempt);
    return { job, attempt, applied: answer.applied === true, outcome: answer.outcome };
  });
}
