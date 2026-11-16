/** Wait for the exact pulled gate job a submit queued, so ship can go on to the verdict or report the red [V4,B3,C7]. */
import { setTimeout as pause } from 'node:timers/promises';
import { pulledRedLines } from '../../logic/show/gate.js';
import { Refused } from '../../../../../packages/kernel/index.js';

/** Budget: how long a green job may wait for the board to apply its receipt before ship calls it stale. */
const RECEIPT_GRACE_MS = 60_000;

/** The red's failing cases as show prints them, led by the job's name, so the refusal itself says what failed. */
function redLines(job, item) {
  return pulledRedLines(job, item).map((line, at) => at === 0 ? line.replace(/^GATE_RED: /u, '') : line);
}

/**
 * Follow a pulled gate job to its receipt. A seat that submitted holds its claim while the gate runs, so the submit
 * itself never blocks; ship waits here instead, until the board has applied the receipt (the item left `claimed`) or the
 * job is red. Why not the review wait: that one needs the submitted state, which only the applied receipt creates.
 *
 * @param {object} ctx - The command context.
 * @param {number} id - The shipped item.
 * @param {{ gateJob: string, commit: string }} submission - The queued submit document.
 * @param {{ withBoardRead: Function, retrySync: Function, getItem: Function, newestGateJob: Function }} ports
 * @param {{ deadlineMs?: number }} [options]
 * @returns {Promise<object>} The settled gate, as the inline submit printed it.
 */
export async function waitForPulledGate(ctx, id, submission, ports, { deadlineMs = 30 * 60_000 } = {}) {
  const deadline = Date.now() + deadlineMs;
  ctx.io.say(`waiting for gate job ${submission.gateJob} on #${id} at ${submission.commit.slice(0, 12)}`);
  let nextSync = 0, doneAt = null;
  while (Date.now() < deadline + 1) {
    if (Date.now() >= nextSync) { await ports.retrySync(ctx.io); nextSync = Date.now() + 2000; }
    const { job, item } = ports.withBoardRead(ctx, board => ({ job: ports.newestGateJob(board.db, id), item: ports.getItem(board, id) }));
    if (job?.step === 'done' && job.gate) {
      // A known-main red is submitted all the same, so a moved item goes on to its verdict whatever the gate's colour.
      if (item.item_status !== 'claimed') return job.gate;
      if (job.gate.green !== true && job.gate.deferred !== true) throw new Refused('GATE_RED', redLines(job, item).join('\n'),
        `run pullboard show ${id} to read the failing cases, fix them, commit, and run pullboard ship again`);
      // The board applies a receipt right after marking the job done; one that never moves the item is a stale gate.
      doneAt ??= Date.now();
      if (Date.now() - doneAt > RECEIPT_GRACE_MS) throw new Refused('SUBMISSION_CHANGED', `gate job ${submission.gateJob} passed but #${id} is still claimed`,
        `run pullboard show ${id} to read its current state`);
    }
    if (Date.now() >= deadline) throw new Refused('SUBMISSION_WAIT_TIMEOUT', `gate wait deadline reached for #${id}; job ${submission.gateJob} has not settled`,
      `run pullboard show ${id} to read the gate; do not resubmit while it is queued`);
    await pause(250);
  }
}

/**
 * The acknowledgment of the pulled gate a plain-text submit just queued: that mode prints prose and hands the caller no
 * document, so the board's newest gate job for a still-claimed item stands in for it.
 *
 * @returns {{ id: number, commit: string, gateJob: string, queued: true } | null}
 */
export function queuedAcknowledgment(ctx, id, commit, ports) {
  return ports.withBoardRead(ctx, board => {
    const job = ports.newestGateJob(board.db, id);
    return job && job.step !== 'done' && ports.getItem(board, id).item_status === 'claimed' ? { id, commit, gateJob: job.id, queued: true } : null;
  });
}
