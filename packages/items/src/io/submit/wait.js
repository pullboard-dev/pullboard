/** Follow the exact acknowledged submission rather than treating submission as completion [V2,B13]. */
import { setTimeout as pause } from 'node:timers/promises';
import { Refused } from "../../../../kernel/index.js";

/** Read under a short-lived connection, releasing it before any sleep or network work. */
function submissionOutcome(ctx, id, commit, submittedEvent, { withBoardRead, events, verdictsFor, getItem }) {
  return withBoardRead(ctx, board => {
    // A verdict can commit between any two reads. One snapshot must cover its event, row and item.
    board.db.exec('BEGIN');
    try {
      const history = events(board, { itemId: id });
      const nextSubmission = history.find(event => event.event_kind === 'submit' && event.event_id > submittedEvent)?.event_id ?? Infinity;
      const receipts = history.filter(event => ['accept', 'reject'].includes(event.event_kind));
      const verdict = verdictsFor(board, id).filter((row, index) =>
        receipts[index]?.event_id > submittedEvent && receipts[index].event_id < nextSubmission)
        .findLast(row => row.verdict_commit === commit && !row.withdrawn);
      const result = { verdict, item: getItem(board, id), attemptChanged: nextSubmission !== Infinity };
      board.db.exec('COMMIT');
      return result;
    } catch (error) {
      board.db.exec('ROLLBACK');
      throw error;
    }
  });
}

/** Keep synchronizing while attached, reporting the recorded verdict and its complete note. */
export async function waitForSubmissionVerdict(ctx, id, submission, receipt, ports, { deadlineMs = 30 * 60_000 } = {}) {
  const { retrySync } = ports;
  const { commit } = submission;
  const submittedEvent = receipt?.event_id;
  if (!Number.isSafeInteger(submittedEvent) || receipt.event_kind !== 'submit' || receipt.item_id !== id
    || JSON.parse(receipt.event_detail).commit !== commit) {
    throw new Refused('SUBMISSION_CHANGED', `the exact acknowledged submission for #${id} is unavailable; run pullboard inbox to synchronize it`);
  }
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) throw new Refused('USAGE', 'review wait needs a finite nonnegative deadline');
  const deadline = Date.now() + deadlineMs;
  ctx.io.say(`waiting for the verdict on #${id} at ${commit.slice(0, 12)} until ${new Date(deadline).toISOString()}`);
  let nextSync = 0;
  for (;;) {
    if (Date.now() >= nextSync) {
      await retrySync(ctx.io);
      nextSync = Date.now() + 2000;
    }
    const { verdict, item, attemptChanged } = submissionOutcome(ctx, id, commit, submittedEvent, ports);
    if (verdict) {
      ctx.io.result?.({ ...submission, verdict });
      ctx.io.say(`${verdict.verdict_decision} #${id}: ${verdict.verdict_note || verdict.verdict_reason}`);
      return verdict.verdict_decision === 'ACCEPT' ? 0 : 1;
    }
    if (attemptChanged || item.item_commit !== commit || item.item_status !== 'submitted') {
      throw new Refused('SUBMISSION_CHANGED', `#${id} left this submission without a verdict; run pullboard show ${id} to read its current state`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Refused('SUBMISSION_WAIT_TIMEOUT',
      `review wait deadline reached for #${id} at ${commit}; its gate is complete and independent review is still pending`,
      `run pullboard show ${id} to read the review state; do not resubmit the completed gate`);
    await pause(Math.min(250, remaining));
  }
}
