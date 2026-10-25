/** Follow the exact acknowledged submission rather than treating submission as completion [V2,B13]. */
import { setTimeout as pause } from 'node:timers/promises';
import * as store from './board.js';
import { withBoardRead } from './board-read.js';
import { retrySync } from './cli-sync.js';
import { Refused } from './refused.js';

/** Read under a short-lived connection, releasing it before any sleep or network work. */
function submissionOutcome(ctx, id, commit) {
  return withBoardRead(ctx, board => {
    const verdict = store.verdictsFor(board, id).findLast(row => row.verdict_commit === commit);
    return { verdict, item: store.getItem(board, id) };
  });
}

/** Keep synchronizing while attached, reporting the recorded verdict and its complete note. */
export async function waitForSubmissionVerdict(ctx, id, commit) {
  ctx.io.say(`waiting for the verdict on #${id} at ${commit.slice(0, 12)}`);
  let nextSync = 0;
  for (;;) {
    if (Date.now() >= nextSync) {
      await retrySync(ctx.io);
      nextSync = Date.now() + 2000;
    }
    const { verdict, item } = submissionOutcome(ctx, id, commit);
    if (verdict) {
      ctx.io.result?.({ id, commit, verdict });
      ctx.io.say(`${verdict.verdict_decision} #${id}: ${verdict.verdict_note || verdict.verdict_reason}`);
      return verdict.verdict_decision === 'ACCEPT' ? 0 : 1;
    }
    if (item.item_commit !== commit || item.item_status !== 'submitted') {
      throw new Refused('SUBMISSION_CHANGED', `#${id} left this submission without a verdict; run pullboard show ${id} to read its current state`);
    }
    await pause(250);
  }
}
