/** Follow the exact acknowledged submission rather than treating submission as completion [V2,B13]. */
import { setTimeout as pause } from 'node:timers/promises';
import * as store from './board.js';
import { withBoardRead } from './board-read.js';
import { retrySync } from './cli-sync.js';
import { Refused } from './refused.js';

/** Read under a short-lived connection, releasing it before any sleep or network work. */
function submissionOutcome(ctx, id, commit, submittedEvent) {
  return withBoardRead(ctx, board => {
    const history = store.events(board, { itemId: id });
    const nextSubmission = history.find(event => event.event_kind === 'submit' && event.event_id > submittedEvent)?.event_id ?? Infinity;
    const receipts = history.filter(event => ['accept', 'reject'].includes(event.event_kind));
    const verdict = store.verdictsFor(board, id).filter((row, index) =>
      receipts[index]?.event_id > submittedEvent && receipts[index].event_id < nextSubmission)
      .findLast(row => row.verdict_commit === commit && !row.withdrawn);
    return { verdict, item: store.getItem(board, id) };
  });
}

/** Keep synchronizing while attached, reporting the recorded verdict and its complete note. */
export async function waitForSubmissionVerdict(ctx, id, submission, receipt) {
  const { commit } = submission;
  const submittedEvent = receipt?.event_id;
  if (!Number.isSafeInteger(submittedEvent) || receipt.event_kind !== 'submit' || receipt.item_id !== id
    || JSON.parse(receipt.event_detail).commit !== commit) {
    throw new Refused('SUBMISSION_CHANGED', `the exact acknowledged submission for #${id} is unavailable; run pullboard inbox to synchronize it`);
  }
  ctx.io.say(`waiting for the verdict on #${id} at ${commit.slice(0, 12)}`);
  let nextSync = 0;
  for (;;) {
    if (Date.now() >= nextSync) {
      await retrySync(ctx.io);
      nextSync = Date.now() + 2000;
    }
    const { verdict, item } = submissionOutcome(ctx, id, commit, submittedEvent);
    if (verdict) {
      ctx.io.result?.({ ...submission, verdict });
      ctx.io.say(`${verdict.verdict_decision} #${id}: ${verdict.verdict_note || verdict.verdict_reason}`);
      return verdict.verdict_decision === 'ACCEPT' ? 0 : 1;
    }
    if (item.item_commit !== commit || item.item_status !== 'submitted') {
      throw new Refused('SUBMISSION_CHANGED', `#${id} left this submission without a verdict; run pullboard show ${id} to read its current state`);
    }
    await pause(250);
  }
}
