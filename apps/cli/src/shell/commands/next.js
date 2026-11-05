import { nextIdleChanged } from '../../../../../packages/store/index.js';
import { sayQueuedReds } from '../../../../../packages/store/index.js';
import { recordedVerificationComparison } from '../../../../../packages/verify/index.js';
import { renderVerificationComparison } from '../../../../../packages/verify/index.js';
import { recordedClaimWorktrees } from '../../../../../packages/activity/index.js';
import { takeWaitShouts } from '../../../../../packages/activity/index.js';
import { agentSessionDigest } from '../../../../../packages/person/index.js';
/** The pullboard next command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import { startNextProgressMonitor } from '../next-progress-monitor.js';
import { mainRedReviewItems } from '../../../../../packages/landing/index.js';
import { mainRedReworkItems } from '../../../../../packages/landing/index.js';
import { computedReturnArgs } from '../../../../../packages/landing/index.js';
import {
  mainRedBuildOffer,
  nextTake,
  nextProgress,
} from '../../../../../packages/sandbox/index.js';
import {
  sayCheckBaseline,
} from '../../../../../packages/gate/index.js';
import {
  refuseNextIdle,
} from '../next-steps.js';
import { reviewPacketLines } from '../../../../../packages/verify/index.js';
import { reviewQueueLine } from '../../../../../packages/verify/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import { seatLeadLine } from '../../../../../packages/seats/index.js';
import { wakeRoutedSeat } from '../../../../../packages/seats/index.js';
import { cleanItemFolders } from '../item-folder.js';
import {
  agentDisplayName,
  MainSpecMerged,
  checkMainVerifier,
  claimFreezer,
  claimOrdered,
  cdTo,
  context,
  displayedWait,
  idArg,
  nextOnce,
  ordered,
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
import { sayMapSlice } from '../../../../../packages/codemap/index.js';
import { primaryCheckoutRoot } from '../cli/worktree.js';

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

/** Put the no-item answer first and compress a large held queue without hiding other wait reasons. */
function answerFirstReasons(reasons) {
  return ['no item is free', ...heldCounted(reasons)];
}

/** Replace each 'is held by coordinator' line with one count line, keeping every other reason [C7,#2895]. */
function heldCounted(reasons) {
  const held = reasons.filter(reason => /^#\d+ is held by coordinator:/u.test(reason));
  const remaining = reasons.filter(reason => !/^#\d+ is held by coordinator:/u.test(reason));
  return [...(held.length ? [`${held.length} ${held.length === 1 ? 'item is' : 'items are'} held by coordinator`] : []), ...remaining];
}

/**
 * Keep the first few reason lines and fold the rest into one counted line naming where to read them [C7,#2895].
 * Why: a long hold or skip list pushed the claim's action off the first screen, and small models lost it.
 *
 * @param {string[]} lines
 * @param {string} more the command that lists every reason
 * @param {number} [keep]
 * @returns {string[]}
 */
export function foldedReasons(lines, more, keep = 5) {
  return lines.length <= keep ? lines : [...lines.slice(0, keep), `+${lines.length - keep} more reasons: ${more}`];
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
  const monitor = await startNextProgressMonitor(io);
  const progress = nextProgress(io, { monitor }), previous = io.nextPhase;
  io.nextPhase = progress.enter;
  try { return await nextWithProgress(io, values, progress); }
  finally { progress.stop(); await monitor?.close(); if (previous === undefined) delete io.nextPhase; else io.nextPhase = previous; }
}

/** Keep native routing and deliberate idle waits separate from bounded nonprogress retries. */
async function nextWithProgress(io, values, progress) {
  progress.enter('context');
  let ctx = context(io);
  withBoardRead(ctx, board => sayQueuedReds(io, board, () => whoAmI(ctx, board)));
  withBoardRead(ctx, board => cleanItemFolders(ctx, board, whoAmI(ctx, board)));
  // Other seats' worktrees come from the maintenance record; only this seat's own claim is observed live (#2427).
  const claimWorktrees = (items, agents, board) => recordedClaimWorktrees(items, agents, board, { own: ctx.info.root });
  const takeServices = { MainSpecMerged, checkMainVerifier, claimFreezer, claimOrdered, idArg, ordered,
    whoAmI, withBoard, withBoardRead, mainRedReviewItems, mainRedReworkItems, computedReturnArgs, agentSessionDigest, claimWorktrees };
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
  values = { ...values, observeIdle: true };
  let lastIdleReason;
  const heardShouts = new Set();
  const deadline = Date.now() + minutes * 60_000;
  const origin = ctx.info.root;
  for (;;) {
    const heard = minutes > 0 ? takeWaitShouts(ctx, heardShouts, { withBoard, withBoardRead, whoAmI }) : null;
    for (const line of heard?.lines ?? []) io.say(line);
    if (heard?.item) {
      io.result?.({ item: heard.item, review: false, held: false, shared: [], reasons: heard.lines });
      io.say(`a shout asks you to act on #${heard.item.item_id}: ${heard.item.item_title}; pullboard show ${heard.item.item_id}`);
      return 0;
    }
    const takeMainRed = await progress.run('main-red routing', null, () => !values.build && !values.verify && values.verifyId === undefined && mainRedBuildOffer(ctx, values, takeServices));
    const found = await progress.run('selection', values.verifyId === undefined ? null : Number(values.verifyId), () => values.take || takeMainRed ? nextTake(ctx, values, takeServices) : nextOnce(ctx, values));
    if (found.context) ctx = found.context;
    if (found.specMerged) {
      io.say(`merged main before claiming #${found.specMerged.item}: added spec rows ${found.specMerged.rows.join(', ')}`);
      ctx = context(io);
      await progress.retry({ retryDetail: { phase: 'main spec merge', item: found.specMerged.item, code: 'MAIN_SPEC_MERGED' } });
      continue;
    }
    if (found.item) {
      found.reasons = [...(found.reasons ?? []), ...inboxReasons(ctx)];
      if (found.lightReserved) io.say(`kept #${found.lightReserved.item_id} for active light seats: ${found.lightReserved.item_title}`);
      if (found.buildOffer || found.releaseRequest) {
        const route = found.buildOffer ?? found.releaseRequest;
        const target = withBoardRead(ctx, board => ({ boardId: store.boardId(board), seat: store.listAgents(board).find(agent => agent.agent_id === route.seat) }));
        const wake = await wakeRoutedSeat(ctx.info, { ...target, item: found.item.item_id });
        if (wake.error) io.err?.(`seat wake unavailable: ${wake.error}`);
        io.result?.({ item: found.item, review: false, held: false,
          ...(found.buildOffer ? { buildOffer: found.buildOffer } : { releaseRequest: found.releaseRequest }) });
        if (found.buildOffer) io.say(`main-red build #${found.item.item_id} offered to free seat ${found.buildOffer.seat}: ${cdTo(found.buildOffer.path)} pullboard next --take`);
        else io.say(`main-red build #${found.item.item_id} needs ${found.releaseRequest.seat} to release newest build #${found.releaseRequest.item}: ${cdTo(found.releaseRequest.path)} pullboard release ${found.releaseRequest.item} --reason ROUTED_ELSEWHERE, then pullboard next --take`);
        return 0;
      }
      if (found.offer) {
        for (const reason of found.reasons ?? []) io.say(reason);
        sayReviewOffer(ctx, found); return 0;
      }
      const item = found.item;
      const review = found.review ?? Boolean(values.verify);
      const agents = withBoardRead(ctx, (board) => store.listAgents(board));
      const comparison = review ? withBoardRead(ctx, board => recordedVerificationComparison(store.itemThread(board, item.item_id), item)) : null;
      io.result?.({ item, review, ...(comparison ? { comparison } : {}), held: Boolean(found.held), ...(found.waitingOffer ? { waitingOffer: true } : {}), shared: found.shared ?? [], reasons: found.reasons ?? [], ...(found.seat ? { seat: found.seat } : {}), ...(found.itemFolder ? { itemFolder: found.itemFolder, holder: found.holder } : {}), ...(found.companions ? { companions: found.companions } : {}) });
      const here = cdTo(!review && found.itemFolder ? found.itemFolder : ctx.info.root);
      const as = ctx.info.isMain ? ' --as coordinator' : '';
      if (review) {
        io.say(`next to verify: #${item.item_id} ${item.item_title}, built by ${agentDisplayName(agents, ctx.config, item.item_built_by)} at ${item.item_commit.slice(0, 12)}`);
        for (const reason of found.reasons ?? []) io.say(displayedWait(reason, agents, ctx.config));
        if (comparison) io.say(renderVerificationComparison(comparison));
        sayCheckBaseline(io, item);
        io.say(`reserved for you until ${item.item_review_until}: another agent's verdict on it is refused until then; pullboard next --verify again renews it`);
        if (found.companions) io.say(`review tree checked out at ${found.companions.commit}; patch-set digest: ${found.companions.digest}; companions: ${found.companions.keys.join(', ')}`);
        else io.say(`check out exactly that commit, here: ${here} git switch --detach ${item.item_commit}`);
        io.say(`then: ${here} pullboard verify ${item.item_id} accept${as} --note "how you proved it", or reject${as} --reason CODE --note "what failed"`);
        // The packet the green gate stored: read it instead of rerunning what the gate already ran (#2451).
        for (const line of await reviewPacketLines(ctx, item.item_id, (work) => withBoardRead(ctx, (board) => work(board, store)))) io.say(line);
      } else {
        if (found.waitingOffer) {
          io.say(`available #${item.item_id}: ${item.item_title}`);
          for (const reason of found.reasons ?? []) io.say(displayedWait(reason, agents, ctx.config));
          io.say(`claim it when ready: ${here} pullboard claim ${item.item_id}`);
          return 0;
        }
        io.say(`${found.held ? (found.seat && found.seat.path !== origin ? `${found.seat.agent} holds` : 'you hold') : 'claimed'} #${item.item_id}: ${item.item_title}`);
        io.say(`next: build and commit in ${found.itemFolder ?? ctx.info.root}, then ${here} pullboard submit ${item.item_id}`);
        for (const line of foldedReasons(heldCounted(found.reasons ?? []).map(reason => displayedWait(reason, agents, ctx.config)), `pullboard list ${item.item_lane}`)) io.say(line);
        if (found.seat && found.seat.path !== origin) io.say(seatLeadLine(found.seat, item, found.held));
        if (found.reviewSkipped) io.say(`${reviewQueueLine(ctx, found.reviewSkipped, span)}; explicit build intent recorded with this claim`);
        if (found.seat) io.say(`${found.seat.created ? 'opened' : 'work in'} ${found.seat.agent}, ${found.seat.lane} lane: ${here}`);
        if (found.itemFolder) io.say(`item folder: ${found.itemFolder}; seat ${found.holder}; build, commit and submit there`);
        if (found.shared?.length) io.say(`it touches ${found.shared.length === 1 ? 'a file' : `${found.shared.length} files`} you worked in recently: ${found.shared.slice(0, 4).join(', ')}`);
        if (item.item_criterion) io.say(`criterion: ${item.item_criterion}`);
        if (item.item_check) io.say(`check: ${item.item_check}   (run it before you submit)`);
        for (const row of item.item_frozen ? JSON.parse(item.item_frozen).rows : []) io.say(`  ${row.id}: ${row.text}`);
        sayBrief(io, item.item_brief);
        await progress.run('code map', item.item_id, () => sayMapSlice(io, ctx, item, primaryCheckoutRoot));
        io.say(`when it is built and committed: ${here} pullboard submit ${item.item_id}`);
      }
      return 0;
    }
    const idleReason = found.idleReason ?? 'unknown';
    if (!found.retry && idleReason !== lastIdleReason) {
      try {
        const changed = withBoardRead(ctx, board => nextIdleChanged(board,
          { agentId: whoAmI(ctx, board).id, reason: idleReason }));
        if (changed) await progress.run('idle observation', null, () => withBoard(ctx, board => ordered(ctx, board, 'recordNextIdle', [{ agentId: whoAmI(ctx, board).id, reason: idleReason }])));
      } catch (error) {
        if (!(error instanceof Refused) || !['RELAY_RECOVERY_PENDING', 'RELAY_KEY_MISSING', 'AUTH_REQUIRED', 'ENGINE_VERSION'].includes(error.code)) throw error;
        // Reading eligibility stays available while canonical writes are fenced; this interval remains unknown.
        io.err(`next idle observation was not recorded (${error.code}); the idle reason remains unmeasured`);
      }
      lastIdleReason = idleReason;
    }
    if (!found.retry && (found.laneWork || Date.now() >= deadline)) {
      if (idleReason === 'focus' && found.reasons?.length === 1 && found.reasons[0].endsWith('overflow is off.')) {
        io.result?.({ item: null, idleReason, reasons: found.reasons });
        io.say(found.reasons[0]);
        return 0;
      }
      if (values.verify) refuseWhileBuilding(ctx);
      found.reasons = [...(found.reasons ?? []), ...inboxReasons(ctx)];
      const agents = withBoardRead(ctx, (board) => store.listAgents(board));
      const seat = withBoardRead(ctx, (board) => whoAmI(ctx, board));
      const reasons = answerFirstReasons(found.reasons);
      return refuseNextIdle(io, reasons, foldedReasons(reasons.map((reason) => displayedWait(reason, agents, ctx.config)), `pullboard list ${seat.lane}`), { minutes, verify: values.verify, laneWork: found.laneWork, lane: seat.lane, route: seat.route });
    }
    if (found.retry) await progress.retry(found, { until: deadline });
    else await progress.idle(found.reasons, () => new Promise((done) => setTimeout(done, 5000)));
  }
}

/** Run `pullboard next` and return its exit code. */
export function run(io, { first, values }) {
  return nextHere(io, { ...values, verifyId: first });
}
