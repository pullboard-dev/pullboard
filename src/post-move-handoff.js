/** Successful native commands hand the same seat its next work without a second process [N2,V1,V4]. */
import { ownSessionReviews } from './next-review.js';
import { Refused } from './refused.js';

/** Keep a successful primary operation visible even when the next native assignment is refused. */
function idle(reasons, error) {
  return { item: null, review: false, held: false, reasons,
    ...(error ? { error: { code: error.code, message: error.message } } : {}) };
}

/** Reuse explicit native next/read ports with unchanged review priority and ordered reservation guards. */
async function takeFollowing(ctx, completedId, { nextOnce, withBoardRead, listItems }) {
  const omitIds = withBoardRead(ctx, board => [completedId, ...ownSessionReviews(ctx.info, board, undefined, { listItems })]);
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

/** Extend the acknowledged result through supplied native next/read operations; opt-out performs neither. */
export async function completeMoveHandoff(ctx, completedId, values, primary, services) {
  if (values['no-next']) return primary;
  let next;
  try { next = await takeFollowing(ctx, completedId, services); }
  catch (error) {
    // The primary native move is already acknowledged; never turn a later read failure into its loss.
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(error.code)
      ? error.code : 'NEXT_UNAVAILABLE';
    const message = 'the next native assignment could not be confirmed; run pullboard next';
    next = { ...idle([message], { code, message }), unavailable: true };
  }
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
