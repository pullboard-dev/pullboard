/** What next prints when it reserves nothing: an offered review, or a builder still at work [C7,P4]. */
import * as store from '../../../../../packages/store/index.js';
import {
  agentDisplayName,
  span,
  whoAmI,
} from '../entry.js';
import { withBoardRead } from '../context.js';
import { reviewQueueLine } from '../../../../../packages/verify/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';

/** Print an unreserved review first, then the build available through an explicit opt-out. */
export function sayReviewOffer(ctx, found) {
  const command = `pullboard next --verify ${found.item.item_id}${ctx.info.isMain ? ' --as coordinator' : ''}`;
  const offer = { item: found.item.item_id, command, queue: found.offer.queue, ratio: found.offer.ratio };
  ctx.io.result?.({ item: found.item, review: true, held: Boolean(found.offer.held), shared: [], offer, build: found.build, ...(found.buildHeld ? { buildHeld: true } : {}) });
  if (found.offer.urgent === 'default-loop') ctx.io.say('review first: plain next takes an eligible review before a build');
  else ctx.io.say(found.offer.urgent === 'held-review' ? `${reviewQueueLine(ctx, offer.queue, span)}; resume the review already reserved by this seat`
    : found.offer.urgent === 'main-red' ? `${reviewQueueLine(ctx, offer.queue, span)}; this review repairs a failure on current main`
    : found.offer.urgent ? `${reviewQueueLine(ctx, offer.queue, span)}; this submission has waited over ${found.offer.starveMinutes ?? 5} minutes without a reviewer`
    : `${reviewQueueLine(ctx, offer.queue, span)}; ratio ${offer.ratio} reached (zero active reviewers counts as one)`);
  const agents = withBoardRead(ctx, (board) => store.listAgents(board));
  ctx.io.say(`review offered: #${found.item.item_id} ${found.item.item_title}, built by ${agentDisplayName(agents, ctx.config, found.item.item_built_by)}; reserve it explicitly: ${command}`);
  if (found.buildHeld) ctx.io.say(`build #${found.build.item_id} stays held with its lease and folder; after the verdict, pullboard next resumes it`);
  else if (found.build) ctx.io.say(`build available: #${found.build.item_id} ${found.build.item_title}; claim it explicitly: pullboard next --build`);
  else ctx.io.say('no build is currently free in your lane; this review is available');
}

/**
 * A review search that found nothing while another agent is still building: say so, with the wait,
 * so a reviewer who starts first is not told NOTHING_FREE as if the board were idle [C7,P4].
 *
 * @param {any} ctx
 */
export function refuseWhileBuilding(ctx) {
  const building = withBoardRead(ctx, (board) => {
    const me = whoAmI(ctx, board).id;
    const items = store.listItems(board);
    if (items.some((item) => item.item_status === 'submitted' && item.item_built_by !== me)) return [];
    return items.filter((item) => item.item_status === 'claimed' && item.item_owner !== me).map((item) => `#${item.item_id}`).reverse();
  });
  if (building.length) throw new Refused('REVIEW_NOT_READY', `nothing to review yet; the builder is still working on ${building.join(', ')}`);
}
