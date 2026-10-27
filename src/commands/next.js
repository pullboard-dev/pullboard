/** The pullboard next command, in its own module so an item adding another command never edits these lines. */
import * as store from '../board.js';
import {
  mainRedBuildOffer,
  nextTake,
} from '../next-take.js';
import {
  sayCheckBaseline,
} from '../check-baseline.js';
import {
  refuseNextIdle,
  reviewQueueLine,
} from '../next-steps.js';
import {
  Refused,
} from '../refused.js';
import * as seatCheckout from '../seat-checkout.js';
import {
  agentDisplayName,
  cdTo,
  context,
  displayedWait,
  idArg,
  nextOnce,
  sayBrief,
  span,
  whoAmI,
  withBoard,
  withBoardRead,
} from '../cli.js';
import {
  refuseWhileBuilding,
  sayReviewOffer,
} from '../next-say.js';

/** Preview governing messages without acknowledging them or changing explicit watch audiences [B7,N2]. */
function inboxReasons(ctx) {
  return withBoardRead(ctx, board => {
    const me = whoAmI(ctx, board);
    const count = store.unreadCount(board, me.id);
    if (!count) return [];
    return [`${count} unread ${count === 1 ? 'message' : 'messages'}; read pullboard inbox`,
      ...store.peekShouts(board, me.id, 2).map(shout => `${shout.shout_from} -> ${shout.shout_to}: ${shout.shout_text}`)];
  });
}

/**
 * `pullboard next` (N2): the whole start of an agent's loop in one command. With --wait, it keeps
 * looking until something is free, so an agent blocked on other work needs no polling of its own.
 *
 * @param {any} io
 * @param {any} values
 * @returns {Promise<number>}
 */
export async function nextHere(io, values) {
  let ctx = context(io);
  if (values.take && (values.build || values.verify || values.verifyId !== undefined || values.as !== undefined)) {
    throw new Refused('USAGE', 'run pullboard next --take without an item id, --build, --verify or --as');
  }
  if (values.build && values.verify) throw new Refused('USAGE', 'choose a build or a review: pullboard next --build or pullboard next --verify');
  if (values.verifyId !== undefined && !values.verify) {
    throw new Refused('USAGE', 'give an item id only with --verify: pullboard next --verify <id>');
  }
  if (values.verifyId !== undefined) idArg(values.verifyId, 'an item id after --verify');
  const minutes = values.wait === undefined ? 0 : Number(values.wait);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 240) {
    throw new Refused('USAGE', '--wait is a number of minutes from 0 to 240');
  }
  const deadline = Date.now() + minutes * 60_000;
  const origin = ctx.info.root;
  for (;;) {
    const takeMainRed = !values.build && !values.verify && values.verifyId === undefined && mainRedBuildOffer(ctx, values);
    const found = values.take || takeMainRed ? await nextTake(ctx, values) : await nextOnce(ctx, values);
    if (found.context) ctx = found.context;
    if (found.specMerged) {
      io.say(`merged main before claiming #${found.specMerged.item}: added spec rows ${found.specMerged.rows.join(', ')}`);
      ctx = context(io);
      continue;
    }
    if (found.item) {
      found.reasons = [...(found.reasons ?? []), ...inboxReasons(ctx)];
      if (found.buildOffer || found.releaseRequest) {
        io.result?.({ item: found.item, review: false, held: false,
          ...(found.buildOffer ? { buildOffer: found.buildOffer } : { releaseRequest: found.releaseRequest }) });
        if (found.buildOffer) io.say(`main-red build #${found.item.item_id} offered to free seat ${found.buildOffer.seat}: ${cdTo(found.buildOffer.path)} pullboard next --take`);
        else io.say(`main-red build #${found.item.item_id} needs ${found.releaseRequest.seat} to release newest build #${found.releaseRequest.item}: ${cdTo(found.releaseRequest.path)} pullboard release ${found.releaseRequest.item}, then pullboard next --take`);
        return 0;
      }
      if (found.offer) {
        for (const reason of found.reasons ?? []) io.say(reason);
        sayReviewOffer(ctx, found); return 0;
      }
      const item = found.item;
      const review = found.review ?? Boolean(values.verify);
      const agents = withBoardRead(ctx, (board) => store.listAgents(board));
      io.result?.({ item, review, held: Boolean(found.held), shared: found.shared ?? [], reasons: found.reasons ?? [], ...(found.seat ? { seat: found.seat } : {}) });
      for (const reason of found.reasons ?? []) io.say(displayedWait(reason, agents, ctx.config));
      const here = cdTo(ctx.info.root);
      const as = ctx.info.isMain ? ' --as coordinator' : '';
      if (review) {
        sayCheckBaseline(io, item);
        io.say(`next to verify: #${item.item_id} ${item.item_title}, built by ${agentDisplayName(agents, ctx.config, item.item_built_by)} at ${item.item_commit.slice(0, 12)}`);
        io.say(`reserved for you until ${item.item_review_until}: another agent's verdict on it is refused until then; pullboard next --verify again renews it`);
        io.say(`check out exactly that commit, here: ${here} git switch --detach ${item.item_commit}`);
        io.say(`then: ${here} pullboard verify ${item.item_id} accept${as} --note "how you proved it", or reject${as} --reason CODE --note "what failed"`);
      } else {
        if (found.seat && found.seat.path !== origin) io.say(seatCheckout.seatLeadLine(found.seat, item, found.held));
        if (found.reviewSkipped) io.say(`${reviewQueueLine(ctx, found.reviewSkipped, span)}; explicit build intent recorded with this claim`);
        io.say(`${found.held ? (found.seat && found.seat.path !== origin ? `${found.seat.agent} holds` : 'you hold') : 'claimed'} #${item.item_id}: ${item.item_title}`);
        if (found.seat) io.say(`${found.seat.created ? 'opened' : 'work in'} ${found.seat.agent}, ${found.seat.lane} lane: ${here}`);
        if (found.shared?.length) io.say(`it touches ${found.shared.length === 1 ? 'a file' : `${found.shared.length} files`} you worked in recently: ${found.shared.slice(0, 4).join(', ')}`);
        if (item.item_criterion) io.say(`criterion: ${item.item_criterion}`);
        if (item.item_check) io.say(`check: ${item.item_check}   (run it before you submit)`);
        for (const row of item.item_frozen ? JSON.parse(item.item_frozen).rows : []) io.say(`  ${row.id}: ${row.text}`);
        sayBrief(io, item.item_brief);
        io.say(`when it is built and committed: ${here} pullboard submit ${item.item_id} --wait`);
      }
      return 0;
    }
    if (!found.retry && (found.laneWork || Date.now() >= deadline)) {
      if (values.verify) refuseWhileBuilding(ctx);
      found.reasons = [...(found.reasons ?? []), ...inboxReasons(ctx)];
      const agents = withBoardRead(ctx, (board) => store.listAgents(board));
      const seat = withBoardRead(ctx, (board) => whoAmI(ctx, board));
      return refuseNextIdle(io, found.reasons, found.reasons.map((reason) => displayedWait(reason, agents, ctx.config)), { minutes, verify: values.verify, laneWork: found.laneWork, lane: seat.lane, route: seat.route });
    }
    if (!found.retry) await new Promise((done) => setTimeout(done, 5000));
  }
}

/** Run `pullboard next` and return its exit code. */
export function run(io, { first, values }) {
  return nextHere(io, { ...values, verifyId: first });
}
