/** Successful native commands hand the same seat its next work without a second process [N2,V1,V4]. */
import { ownSessionReviews } from '../next.js';
import { Refused } from '../../../../kernel/index.js';

/** Keep a successful primary operation visible even when the next native assignment is refused. */
function idle(reasons, error) {
  return { item: null, review: false, held: false, reasons,
    ...(error ? { error: { code: error.code, message: error.message } } : {}) };
}

/** Reuse explicit native next/read ports with unchanged review priority and ordered reservation guards. */
async function takeFollowing(ctx, completedId, { nextOnce, withBoardRead, listItems, agentSessionDigest, reviewOnly }) {
  const omitIds = withBoardRead(ctx, board => [completedId, ...ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems })]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      // A verify accept or reject asks for review work only: a reviewer seat never claims a build item here [C7,#11017].
      let found = await nextOnce(ctx, reviewOnly ? { omitIds, verify: true } : { omitIds });
      if (found.context) ctx = found.context;
      if (found.skipItem) omitIds.push(found.skipItem); // its folder is another live session's (#3688)
      if (found.retry) continue;
      let review = Boolean(found.review) || Boolean(reviewOnly);
      if (found.offer) {
        found = await nextOnce(ctx, { verify: true, verifyId: found.item.item_id });
        review = true;
      }
      if (found.retry) continue;
      if (!found.item) return idle(reviewOnly ? ['no eligible review work'] : found.reasons?.length ? found.reasons : ['no eligible work in this seat']);
      return { item: found.item, review, held: Boolean(found.held), reasons: found.reasons ?? [],
        ...(found.seat ? { seat: found.seat } : {}), ...(found.companions ? { companions: found.companions } : {}), ...(found.shared?.length ? { shared: found.shared } : {}) };
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      if (error.code === 'GIT_SYNC_FOLDER') throw error; // The acknowledged move survives; the outer boundary reports an unavailable read.
      if (['HELD', 'NOT_REVIEWABLE', 'ITEM_HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) continue;
      return idle([`${error.code}: ${error.message}`], error);
    }
  }
  return idle(['the queue changed during dispatch; run pullboard next']);
}

/**
 * Extend the acknowledged result: a verify verdict reserves the next review through the supplied native next/read
 * operations; a submit claims nothing and names the next step; opt-out performs none. Why: the submit result itself
 * claimed builds across lanes the seat was never joined to, so taking work is only ever `pullboard next` [C7,#12020].
 */
export async function completeMoveHandoff(ctx, completedId, values, primary, services) {
  if (values['no-next']) return primary;
  if (!services.reviewOnly) {
    const result = { ...primary, next: { item: null, review: false, held: false, reasons: ['run pullboard next'] } };
    ctx.io.result?.(result);
    ctx.io.say('next: run pullboard next');
    return result;
  }
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
    if (next.companions) ctx.io.say(`review tree checked out at ${next.companions.commit}; patch-set digest: ${next.companions.digest}; companions: ${next.companions.keys.join(', ')}`);
    if (next.item.item_check) ctx.io.say(`check: ${next.item.item_check}`);
  } else {
    ctx.io.say(`next: no eligible work; ${next.reasons.join('; ').replace(/[\r\n]+/gu, ' ')}`);
  }
  return result;
}
