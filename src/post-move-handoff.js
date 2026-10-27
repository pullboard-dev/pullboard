/** Successful native commands hand the same seat its next work without a second process [N2,V1,V4]. */
import {
  nextOnce,
  withBoardRead,
} from './cli.js';
import { ownSessionReviews } from './next-review.js';
import { Refused } from './refused.js';

/** Keep a successful primary operation visible even when the next native assignment is refused. */
function idle(reasons, error) {
  return { item: null, review: false, held: false, reasons,
    ...(error ? { error: { code: error.code, message: error.message } } : {}) };
}

/** Reuse native review thresholds, priority, authority and ordered claim/reservation guards. */
async function takeFollowing(ctx, completedId) {
  const omitIds = withBoardRead(ctx, board => [completedId, ...ownSessionReviews(ctx.info, board)]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      let found = await nextOnce(ctx, { omitIds });
      if (found.context) ctx = found.context;
      if (found.retry) continue;
      let review = Boolean(found.review);
      if (found.offer) {
        found = await nextOnce(ctx, { verify: true, verifyId: found.item.item_id });
        review = true;
      }
      if (found.retry) continue;
      if (!found.item) return idle(found.reasons?.length ? found.reasons : ['no eligible work in this seat']);
      return { item: found.item, review, held: Boolean(found.held), reasons: found.reasons ?? [],
        ...(found.seat ? { seat: found.seat } : {}), ...(found.shared?.length ? { shared: found.shared } : {}) };
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      if (['HELD', 'NOT_REVIEWABLE', 'ITEM_HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) continue;
      return idle([`${error.code}: ${error.message}`], error);
    }
  }
  return idle(['the queue changed during dispatch; run pullboard next']);
}

/** Extend, never replace, the acknowledged command result; opt-out performs no next lookup or move. */
export async function completeMoveHandoff(ctx, completedId, values, primary) {
  if (values['no-next']) return primary;
  const next = await takeFollowing(ctx, completedId);
  const result = { ...primary, next };
  ctx.io.result?.(result);
  if (next.item) {
    ctx.io.say(`next ${next.review ? 'review reserved' : next.held ? 'work held' : 'build claimed'}: #${next.item.item_id} ${next.item.item_title}`);
    if (next.item.item_check) ctx.io.say(`check: ${next.item.item_check}`);
  } else {
    ctx.io.say(`next: no eligible work; ${next.reasons.join('; ').replace(/[\r\n]+/gu, ' ')}`);
  }
  return result;
}
