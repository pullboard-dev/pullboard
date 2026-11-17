/** @pullboard-module-loads packages/moves/src/logic/reasons.js packages/health/index.js */
import { holdsRequireOwner } from '../../../../../packages/config/index.js';
import { nextIdleBlockers } from '../../../../../packages/config/index.js';
import { nextAdoptPreserved } from '../../../../../packages/config/index.js';
import { nextItemNotices } from '../../../../../packages/config/index.js';
import { reviewStarveShout } from '../../../../../packages/config/index.js';
import { nextRouteByTier } from '../../../../../packages/config/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { fileChangeWaiter } from '../../../../../packages/activity/index.js';
import { nextIdleChanged } from '../../../../../packages/store/index.js';
import { recordedVerificationComparison } from '../../../../../packages/verify/index.js';
import { renderVerificationComparison } from '../../../../../packages/verify/index.js';
import { recordedClaimWorktrees } from '../../../../../packages/activity/index.js';
import { takeWaitShouts } from '../../../../../packages/activity/index.js';
import { coordinatorCalloutLine } from '../../../../../packages/activity/index.js';
import { agentSessionDigest } from '../../../../../packages/person/index.js';
/** The pullboard next command, in its own module so an item adding another command never edits these lines. */
import * as store from '../../../../../packages/store/index.js';
import { startNextProgressMonitor } from '../next/monitor.js';
import { mainRedReviewItems } from '../../../../../packages/landing/index.js';
import { mainRedReworkItems } from '../../../../../packages/landing/index.js';
import { passingMainRedItems } from '../../../../../packages/landing/index.js';
import { computedReturnArgs } from '../../../../../packages/landing/index.js';
import {
  mainRedBuildOffer,
  nextTake,
  closePassingMainReds,
  nextProgress,
} from '../../../../../packages/sandbox/index.js';
import {
  retainedGateAssertions,
  sayCheckBaseline,
} from '../../../../../packages/gate/index.js';
import {
  refuseNextIdle,
} from '../next/steps.js';
import { reviewPacketLines } from '../../../../../packages/verify/index.js';
import { reviewQueueLine } from '../../../../../packages/verify/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import { seatLeadLine } from '../../../../../packages/seats/index.js';
import { wakeRoutedSeat } from '../../../../../packages/seats/index.js';
import { cleanItemFolders } from '../item/folder.js';
import { sayLag } from '../lag.js';
import { fallbackReclaim } from '../reclaim.js';
import { restartDeadRunner } from '../runner/restart.js';
import { agentDisplayName } from '../context.js';
import { cdTo } from '../context.js';
import { context } from '../context.js';
import { idArg } from '../context.js';
import { sayBrief } from '../context.js';
import { span } from '../context.js';
import { withBoard } from '../context.js';
import { withBoardRead } from '../context.js';
import { MainSpecMerged } from '../claim.js';
import { claimFreezer } from '../claim.js';
import { claimOrdered } from '../claim.js';
import { ordered } from '../claim.js';
import { checkMainVerifier } from '../verify.js';
import { displayedWait } from '../next.js';
import { nextOnce } from '../next.js';
import { loadHold } from '../next.js';
import { seatClaims } from '../next.js';
import { topUpClaims } from '../next.js';
import { whoAmI } from '../join.js';
import {
  refuseWhileBuilding,
  sayReviewOffer,
} from '../next/say.js';
import { sayMapSlice } from '../../../../../packages/codemap/index.js';
import { primaryCheckoutRoot } from '../worktree.js';
import { deliverOwnTestRuns } from '../../../../../packages/drive/index.js';
import { deliverTestRunsWhenReady } from '../../../../../packages/drive/index.js';
import { createRequire } from 'node:module';

/** Next's wait reasons, loaded at the first answer that words them [C7,#7081]. */
const requireModule = createRequire(import.meta.url);
const reasons = () => requireModule('../../../../../packages/moves/src/logic/reasons.js');
/** The review-cover shout, with the health cell behind it, loaded only when a fresh claim shouts it. */
const shoutReviewCoverStuck = (...args) => requireModule('../../../../../packages/health/index.js').shoutReviewCoverStuck(...args);
const shoutStarvedReviews = (...args) => requireModule('../../../../../packages/health/index.js').shoutStarvedReviews(...args);

/** Watch symbolic ref targets as well as HEAD, including projects whose trunk is not named main. */
function nextChangeInputs(ctx) {
  const heads = [...new Set([join(ctx.info.gitDir, 'HEAD'), join(ctx.info.commonDir, 'HEAD')])];
  const refs = heads.flatMap(path => {
    try { const ref = /^ref: (.+)$/mu.exec(readFileSync(path, 'utf8')); return ref ? [join(ctx.info.commonDir, ref[1])] : []; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
  return [ctx.file, ctx.file + '-wal', ...heads, ...refs, join(ctx.info.commonDir, 'packed-refs'),
    join(ctx.info.root, 'pullboard.json'), join(ctx.info.root, ctx.config.spec || 'SPEC.md'), join(ctx.info.root, ctx.config.practice || 'DOCTRINE.md')];
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
  const defaultLoop = !values.take && !values.build && !values.verify && values.verifyId === undefined && values.wait === undefined;
  values = { ...values, defaultLoop };
  const monitor = startNextProgressMonitor(io);
  const previousDefaultLoop = io.defaultLoop;
  // A successful default next can claim through the shared native move pipeline; keep presence diagnostics inside its 2 KB output contract.
  if (defaultLoop) io.defaultLoop = true;
  const progress = nextProgress(io, { monitor }), previous = io.nextPhase;
  io.nextPhase = progress.enter;
  try {
    const code = await nextWithProgress(io, values, progress);
    sayCoordinatorCallouts(io);
    return code;
  }
  catch (error) {
    // A refusal such as refuseNextIdle or refuseWhileBuilding ends the next too; the builder still hears the call-outs [N2,C7].
    sayCoordinatorCallouts(io);
    throw error;
  }
  finally {
    progress.stop(); await monitor?.close();
    if (process.env.PULLBOARD_NEXT_PROFILE) sayNextProfile(io, progress.profile());
    if (previous === undefined) delete io.nextPhase; else io.nextPhase = previous;
    if (previousDefaultLoop === undefined) delete io.defaultLoop; else io.defaultLoop = previousDefaultLoop;
  }
}

/**
 * Print each next phase's milliseconds and name the slowest three, on stderr so JSON stdout stays whole.
 * Why: the 0.2 s budget needs a measured profile of the real-size board before any phase is optimised (#6290).
 *
 * @param {any} io
 * @param {{phase: string, ms: number}[]} phases Slowest first.
 */
function sayNextProfile(io, phases) {
  const write = text => (io.stderr?.write ? io.stderr.write(text + '\n') : io.err?.(text));
  for (const row of phases) write(`next profile: ${row.phase} ${Math.round(row.ms)} ms`);
  write(`next profile: total ${Math.round(phases.reduce((sum, row) => sum + row.ms, 0))} ms; slowest three: ${phases.slice(0, 3).map(row => row.phase).join(', ')}`);
}

/**
 * Last line of every next: unanswered coordinator call-outs older than 15 minutes, so a builder passes them on [N2,C7].
 * Why: sentinel and builder shouts to the coordinator sat unanswered for hours with nothing telling anyone.
 * Best effort and read-only: a board that cannot be read adds no line.
 *
 * @param {any} io
 */
function sayCoordinatorCallouts(io) {
  try {
    const line = withBoardRead(context(io), board => coordinatorCalloutLine(board, board.clock.now().getTime()));
    if (line) io.say(line);
  } catch { /* a missing or unreadable board has no call-outs to report */ }
}

/** Keep native routing and deliberate idle waits separate from bounded nonprogress retries. */
async function nextWithProgress(io, values, progress) {
  progress.enter('context');
  let ctx = context(io);
  // One fallback reclaim pass before answering: a gate job stalled by a dead dispatcher moves one step (DJ15).
  await fallbackReclaim(ctx, 'next');
  // A gate job waiting with no live runner brings this machine's local runner back, and says so in one line [#6556].
  const restarted = await restartDeadRunner(ctx);
  if (restarted) io.say(restarted);
  // Main records each red as delivered so it is not re-announced; the default loop prints the bounded form (#2777).
  // Read first: an idle poll with no queued red opens no write-capable connection [V15,C7].
  const hasQueuedReds = withBoardRead(ctx, board => {
    const me = whoAmI(ctx, board);
    return store.queuedReds(board, me.id).some(red =>
      !store.activityInterruptWasDelivered(board, me.id, `event:${red.eventId}`));
  });
  if (hasQueuedReds) withBoard(ctx, board => {
    const me = whoAmI(ctx, board);
    const reds = store.queuedReds(board, me.id).filter(red =>
      !store.activityInterruptWasDelivered(board, me.id, `event:${red.eventId}`));
    if (reds.length) {
      const activity = store.activityDeliveryState(board, me.id);
      store.recordActivityDelivery(board, { agentId: me.id, through: activity.through,
        observedThrough: Math.max(...reds.map(red => red.observedThrough)), interrupts: reds.map(red => ({
          id: `event:${red.eventId}`, eventId: red.eventId, reason: 'queued-red', item: red.id, commit: red.commit,
        })) });
      const lines = values.defaultLoop === true ? store.boundedQueuedRedLines(reds) : store.queuedRedLines(reds);
      for (const line of lines) io.say(line);
    }
  });
  sayLag(io, ctx);
  // review.starveShout (off by default): a green submission no seat may review reaches the coordinator once, naming the guards [C7,#9682].
  if (reviewStarveShout()) await withBoard(ctx, board => shoutStarvedReviews(ctx, board, ordered));
  // A seat's queued test runs come back first, like a red gate: green or red, failing tests, log [C7].
  const testRuns = deliverOwnTestRuns(io, ctx, { withBoard, withBoardRead, whoAmI });
  withBoardRead(ctx, board => cleanItemFolders(ctx, board, whoAmI(ctx, board), { spare: !values.verify }));
  // Other seats' worktrees come from the maintenance record; only this seat's own claim is observed live (#2427).
  const claimWorktrees = (items, agents, board) => recordedClaimWorktrees(items, agents, board, { own: ctx.info.root });
  const takeServices = { MainSpecMerged, checkMainVerifier, claimFreezer, claimOrdered, idArg, ordered,
    whoAmI, withBoard, withBoardRead, mainRedReviewItems, mainRedReworkItems, passingMainRedItems, computedReturnArgs, agentSessionDigest, claimWorktrees, shoutReviewCoverStuck };
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
  // next.idleBlockers (off by default): an idle answer also names what the waiting items wait on [C7,#2958].
  values = { ...values, observeIdle: true, idleBlockers: nextIdleBlockers() };
  let lastIdleReason;
  const heardShouts = new Set();
  const deadline = Date.now() + minutes * 60_000;
  const origin = ctx.info.root;
  let wake = minutes > 0 ? fileChangeWaiter(nextChangeInputs(ctx)) : null;
  let wakeVersion = wake?.version();
  try { for (;;) {
    const heard = minutes > 0 ? takeWaitShouts(ctx, heardShouts, { withBoard, withBoardRead, whoAmI }) : null;
    for (const line of heard?.lines ?? []) io.say(line);
    if (heard?.item) {
      io.result?.({ item: heard.item, review: false, held: false, shared: [], reasons: heard.lines });
      io.say(`a shout asks you to act on #${heard.item.item_id}: ${heard.item.item_title}; pullboard show ${heard.item.item_id}`);
      return 0;
    }
    // A waiting next wakes on the board file, so a queued test run that finishes meanwhile comes back at once [C7].
    if (minutes > 0 && testRuns.pending.length && deliverOwnTestRuns(io, ctx, { withBoard, withBoardRead, whoAmI }).delivered) return 0;
    if (!values.verify) {
      const ownerQueue = withBoardRead(ctx, board => {
        const me = whoAmI(ctx, board);
        return store.ownershipWaiting(board, ctx.info.isMain ? 'coordinator' : me.lane);
      });
      if (ownerQueue.length) {
        io.result?.({ action: 'ownership', ownershipWaiting: ownerQueue });
        for (const waiting of ownerQueue) {
          io.say(`#${waiting.item} waits on your ownership of ${waiting.paths.join(', ')}`);
          io.say(`source: ${waiting.commit} (${waiting.sourceRef})`);
          io.say(waiting.diff);
        }
        return 0;
      }
    }
    // A wait call reports a failed queued gate once, then omits that still-red claim while looking for other work.
    const redClaims = minutes > 0 ? withBoardRead(ctx, board => store.queuedReds(board, whoAmI(ctx, board).id).map(red => red.id)) : [];
    // next.routeByTier (off by default): open items the project's tiers route to another tier than this seat's are left out of its pick [C7,#8800].
    const tierLeftOut = nextRouteByTier() && !values.verify ? withBoardRead(ctx, board => requireModule('../../../../../packages/moves/src/io/tier-routing.js').tierOmissions(ctx.config, board, store.listItems(board), whoAmI(ctx, board))) : [];
    const selectionValues = redClaims.length || tierLeftOut.length
      ? { ...values, omitIds: [...new Set([...(values.omitIds ?? []), ...redClaims, ...tierLeftOut])] }
      : values;
    // Every route closes Main red items main already proves green before it selects, so no builder is sent to them (#3382).
    await closePassingMainReds(ctx, takeServices);
    const takeMainRed = await progress.run('main-red routing', null, () => !selectionValues.take && !selectionValues.build && !selectionValues.verify && selectionValues.verifyId === undefined && mainRedBuildOffer(ctx, selectionValues, takeServices));
    const found = await progress.run('selection', selectionValues.verifyId === undefined ? null : Number(selectionValues.verifyId), () => loadHold(ctx, selectionValues) ?? (selectionValues.take || takeMainRed ? nextTake(ctx, selectionValues, takeServices) : nextOnce(ctx, selectionValues)));
    if (found.ownershipWaiting?.length) {
      io.result?.({ action: 'ownership', ownershipWaiting: found.ownershipWaiting });
      for (const waiting of found.ownershipWaiting) {
        io.say(`#${waiting.item} waits on your ownership of ${waiting.paths.join(', ')}`);
        io.say(`source: ${waiting.commit} (${waiting.sourceRef})`);
        io.say(waiting.diff);
      }
      return 0;
    }
    if (found.context) ctx = found.context;
    if (found.specMerged) {
      io.say(`merged main before claiming #${found.specMerged.item}: added spec rows ${found.specMerged.rows.join(', ')}`);
      ctx = context(io);
      await progress.retry({ retryDetail: { phase: 'main spec merge', item: found.specMerged.item, code: 'MAIN_SPEC_MERGED' } });
      continue;
    }
    if (found.diagnose) { sayDiagnoseOffer(io, found); return 0; }
    if (found.item) {
      found.reasons = [...(found.reasons ?? []), ...(found.review ? [] : withBoardRead(ctx, board => reasons().ownWaitingLines(board, whoAmI(ctx, board)))), ...withBoardRead(ctx, board => reasons().inboxReasons(board, whoAmI(ctx, board))), ...withBoardRead(ctx, board => reasons().lapsedHoldLines(board, whoAmI(ctx, board), holdsRequireOwner()))];
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
      // "you hold" is printed only after this read finds the item claimed by this seat under a live lease; otherwise selection runs again [C7,#4056].
      if (found.held && !found.review && !values.verify && !found.waitingOffer) {
        const stillHeld = withBoardRead(ctx, board => {
          const fresh = store.getItem(board, found.item.item_id);
          return fresh?.item_status === 'claimed' && fresh.item_owner === whoAmI(ctx, board).id && fresh.item_lease_until > board.clock.now().toISOString();
        });
        if (!stillHeld) { values = { ...values, omitIds: [...new Set([...(values.omitIds ?? []), found.item.item_id])] }; continue; }
      }
      const item = found.item;
      const review = found.review ?? Boolean(values.verify);
      const agents = withBoardRead(ctx, (board) => store.listAgents(board));
      if (review && !found.landed) { try { await (await import('./verify.js')).reviveStalledComparison(ctx, item.item_id); } catch { /* A comparison is observation only; it never blocks a review offer. */ } }
      const comparison = review && !found.landed ? withBoardRead(ctx, board => recordedVerificationComparison(store.itemThread(board, item.item_id), item)) : null;
      const returned = review || found.waitingOffer ? null : withBoardRead(ctx, board => {
        const record = store.returnedRecord(board, item.item_id);
        return record && { ...record, ...(record.gate ? { gate: { ...record.gate, failing: retainedGateAssertions(ctx.info.commonDir, record.gate.job) } } : {}) };
      });
      // The default loop tops this seat up to N build claims whose files are disjoint, each in its own folder [C7,#6263,#7461].
      const own = !found.held || !found.seat || found.seat.path === origin;
      const more = !review && own && !found.waitingOffer && found.itemFolder && values.defaultLoop ? await topUpClaims(ctx, values) : [];
      // next.itemNotices (off by default): the shouts and rulings that name this item ride on the build instruction [C7,#8787].
      const notices = !review && !found.waitingOffer && nextItemNotices() ? withBoardRead(ctx, board => reasons().itemNoticeLines(board, item.item_id)) : [];
      io.result?.({ item, review, ...(notices.length ? { notices } : {}), ...(returned ? { returned } : {}), ...(comparison ? { comparison } : {}), held: Boolean(found.held), ...(found.waitingOffer ? { waitingOffer: true } : {}), shared: found.shared ?? [], reasons: found.reasons ?? [], ...(found.seat ? { seat: found.seat } : {}), ...(found.itemFolder ? { itemFolder: found.itemFolder, holder: found.holder } : {}), ...(found.companions ? { companions: found.companions } : {}), ...(more.length ? { more: more.map(next => ({ item: next.item, itemFolder: next.itemFolder })) } : {}) });
      const here = cdTo(!review && found.itemFolder ? found.itemFolder : ctx.info.root);
      const as = ctx.info.isMain ? ' --as coordinator' : '';
      if (found.landed) {
        // A forced landing has no reservation and no submitted head: the review is of the merge's own first-parent diff, and the verdict is recorded on the board [C7,#6490].
        io.say(`next to verify (landed, no verdict): #${item.item_id} ${item.item_title}, merged as ${item.item_merged_commit.slice(0, 12)}`);
        io.say(`read the merge's own change, here: ${here} git diff ${item.item_merged_commit}^1 ${item.item_merged_commit}`);
        io.say(`then: ${here} pullboard verify ${item.item_id} accept${as} --note "how you proved it", or reject${as} --reason CODE --note "what failed"`);
      } else if (review) {
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
        // An infrastructure stop is not the candidate's red: next gives the same instruction show does, and nothing to build (#4989).
        const infraStop = returned?.gate?.code === 'GATE_INFRA_EXHAUSTED';
        if (!infraStop) io.say(`next: build and commit in ${found.itemFolder ?? ctx.info.root}, then ${here} pullboard submit ${item.item_id}`);
        if (returned) {
          if (infraStop) {
            io.say(`infrastructure stop at ${String(returned.gate.commit).slice(0, 12)}, not a red on the candidate: GATE_INFRA_EXHAUSTED${returned.gate.message ? `: ${returned.gate.message}` : ''}`);
            io.say(`next: ${returned.gate.next ?? 'nothing to do as the builder: the coordinator restores the named runner and requeues this gate'}`);
            return 0;
          }
          if (returned.gate) {
            io.say(`returned red at ${String(returned.gate.commit).slice(0, 12)}: ${returned.gate.code ?? returned.gate.state}${returned.gate.message ? `: ${returned.gate.message}` : ''}`);
            for (const line of returned.gate.failing) io.say(`  gate red: ${line}`);
          }
          if (returned.reject) io.say(`rejected ${returned.reject.reason} by ${returned.reject.by} at ${String(returned.reject.commit).slice(0, 12)}: ${returned.reject.note}`);
          for (const fact of returned.facts) io.say(`  builder fact, ${fact}`);
        }
        for (const line of reasons().foldedReasons(reasons().heldCounted(found.reasons ?? []).map(reason => displayedWait(reason, agents, ctx.config)), `pullboard list ${item.item_lane}`)) io.say(line);
        if (found.seat && found.seat.path !== origin) io.say(seatLeadLine(found.seat, item, found.held));
        if (found.reviewSkipped) io.say(`${reviewQueueLine(ctx, found.reviewSkipped, span)}; explicit build intent recorded with this claim`);
        if (found.seat) io.say(`${found.seat.created ? 'opened' : 'work in'} ${found.seat.agent}, ${found.seat.lane} lane: ${here}`);
        if (found.itemFolder) io.say(`item folder: ${found.itemFolder}; seat ${found.holder}; build, commit and submit there`);
        // next.adoptPreserved (off by default): a returned item's pinned head is merged into the folder this claim opened [C7,#9689].
        if ((found.itemFolder || own) && !found.held && values.take && nextAdoptPreserved()) await (await import('../resume/adopt.js')).adoptReturnedWork(io, ctx, item.item_id, found.itemFolder ?? ctx.info.root);
        if (found.shared?.length) io.say(`it touches ${found.shared.length === 1 ? 'a file' : `${found.shared.length} files`} you worked in recently: ${found.shared.slice(0, 4).join(', ')}`);
        if (item.item_criterion) io.say(`criterion: ${item.item_criterion}`);
        if (item.item_check) io.say(`check: ${item.item_check}   (run it before you submit)`);
        for (const row of item.item_frozen ? JSON.parse(item.item_frozen).rows : []) io.say(`  ${row.id}: ${store.readableRigorText(row.text)}`);
        sayBrief(io, item.item_brief);
        for (const line of notices) io.say(`  ${line}`);
        await progress.run('code map', item.item_id, () => sayMapSlice(io, ctx, item, primaryCheckoutRoot));
        io.say(`when it is built and committed: ${here} pullboard submit ${item.item_id}`);
        for (const next of more) {
          io.say(`claimed #${next.item.item_id}: ${next.item.item_title}`);
          io.say(`item folder: ${next.itemFolder}; seat ${next.holder}; build, commit and submit there`);
          if (next.item.item_criterion) io.say(`criterion: ${next.item.item_criterion}`);
          if (next.item.item_check) io.say(`check: ${next.item.item_check}   (run it before you submit)`);
          io.say(`when it is built and committed: ${cdTo(next.itemFolder)} pullboard submit ${next.item.item_id}`);
        }
        if (more.length) io.say(`you hold ${seatClaims(ctx).map(id => `#${id}`).join(', ')}: build each in its own folder`);
      }
      return 0;
    }
    const idleReason = found.idleReason ?? 'unknown';
    const idleObservation = { reason: idleReason, skips: found.skips ?? [] };
    const idleKey = JSON.stringify(idleObservation);
    let recordedIdle = false;
    if (!found.retry && idleKey !== lastIdleReason) {
      try {
        const changed = withBoardRead(ctx, board => nextIdleChanged(board,
          { agentId: whoAmI(ctx, board).id, ...idleObservation }));
        if (changed) {
          await progress.run('idle observation', null, () => withBoard(ctx, board => ordered(ctx, board, 'recordNextIdle', [{ agentId: whoAmI(ctx, board).id, ...idleObservation }])));
          recordedIdle = true;
        }
      } catch (error) {
        if (!(error instanceof Refused) || !['RELAY_RECOVERY_PENDING', 'RELAY_KEY_MISSING', 'AUTH_REQUIRED', 'ENGINE_VERSION'].includes(error.code)) throw error;
        // Reading eligibility stays available while canonical writes are fenced; this interval remains unknown.
        io.err(`next idle observation was not recorded (${error.code}); the idle reason remains unmeasured`);
      }
      lastIdleReason = idleKey;
    }
    if (!found.retry && (found.laneWork || Date.now() >= deadline)) {
      // Nothing else to build: the board holds this next until the seat's own queued test run comes back [C7].
      if (testRuns.pending.length && await deliverWhenReady(io, ctx)) return 0;
      if (idleReason === 'focus' && found.reasons?.length === 1 && found.reasons[0].endsWith('overflow is off.')) {
        io.result?.({ item: null, idleReason, reasons: found.reasons });
        io.say(found.reasons[0]);
        for (const line of blockerLines(found)) io.say(line);
        return 0;
      }
      if (values.verify) refuseWhileBuilding(ctx);
      if (values.defaultLoop && !found.laneWork) {
        // A named step, such as waiting on another seat's rework, says what to do instead of ending the turn (#7922).
        const step = found.nextStep ?? 'nothing for this seat: end your turn';
        const lapsed = withBoardRead(ctx, board => reasons().lapsedHoldLines(board, whoAmI(ctx, board), holdsRequireOwner()));
        io.result?.({ item: null, next: step, reasons: [...(found.reasons ?? []), ...lapsed] });
        for (const line of lapsed) io.say(line);
        io.say(`next: ${step}`);
        return 0;
      }
      found.reasons = [...(found.reasons ?? []), ...withBoardRead(ctx, board => reasons().inboxReasons(board, whoAmI(ctx, board))), ...withBoardRead(ctx, board => reasons().lapsedHoldLines(board, whoAmI(ctx, board), holdsRequireOwner()))];
      const agents = withBoardRead(ctx, (board) => store.listAgents(board));
      const seat = withBoardRead(ctx, (board) => whoAmI(ctx, board));
      const waits = reasons().answerFirstReasons(found.reasons);
      const refused = refuseNextIdle(io, waits, reasons().foldedReasons(waits.map((reason) => displayedWait(reason, agents, ctx.config)), `pullboard list ${seat.lane}`), { minutes, verify: values.verify, laneWork: found.laneWork, lane: seat.lane, route: seat.route });
      for (const line of blockerLines(found)) io.say(line);
      return refused;
    }
    // An item whose folder another live session holds stays out of this next's selection (#3688).
    if (found.skipItem && ['ITEM_FOLDER_UNFINISHED', 'ITEM_FOLDER_PROTECTED', 'NO_POLICY', 'NOT_READY'].includes(found.retryDetail?.code)) io.say(`skipped #${found.skipItem}: ${found.retryDetail.message}`);
    if (found.skipItem) values = { ...values, omitIds: [...new Set([...(values.omitIds ?? []), found.skipItem])] };
    if (found.retry) await progress.retry(found, { until: deadline });
    else {
      if (recordedIdle && wake) {
        // The idle record itself changes the watched board; rebuild and reread selection before waiting so that
        // its own notification is not mistaken for external work, while changes during rearming remain visible.
        await yieldEventLoop();
        wake.close();
        wake = fileChangeWaiter(nextChangeInputs(ctx));
        wakeVersion = wake.version();
        continue;
      }
      wake.update(nextChangeInputs(ctx));
      const until = withBoardRead(ctx, board => {
        const now = ctx.clock.now().toISOString();
        const row = board.db.prepare(`SELECT MIN(expiry) AS expiry FROM (
          SELECT item_lease_until AS expiry FROM item WHERE item_status='claimed' AND item_lease_until>?
          UNION ALL SELECT item_review_until AS expiry FROM item WHERE item_status='submitted' AND item_review_until>?)`).get(now, now);
        const due = row?.expiry ? [Date.parse(row.expiry)] : [];
        const cooldown = (ctx.config.claims?.releaseCooldownMinutes ?? 30) * 60_000;
        if (cooldown > 0) {
          const release = board.db.prepare("SELECT MIN(event_at) AS at FROM event WHERE event_kind='release' AND event_by=? AND event_at>?")
            .get(whoAmI(ctx, board).id, new Date(ctx.clock.now().getTime() - cooldown).toISOString());
          if (release?.at) due.push(Date.parse(release.at) + cooldown);
        }
        return due.length ? Math.min(deadline, Date.now() + Math.min(...due) - ctx.clock.now().getTime()) : deadline;
      });
      await progress.idle(found.reasons, () => wake.wait({ after: wakeVersion, deadline: until }));
      wakeVersion = wake.version();
    }
  } } finally { wake?.close(); }
}

/**
 * The up-to-three 'blocked: #N waits on #M' lines an idle answer adds when next.idleBlockers is on [C7,#2958].
 * Why: an empty next said only that nothing was free; the waiting items and what holds them tell the seat who to nudge.
 */
function blockerLines(found) {
  return (found.blockers ?? []).slice(0, 3).map(row => `blocked: #${row.item} waits on #${row.waitsOn}`);
}

/** Hold an idle next on the board file until the seat's queued test run comes back; true when one did [C7]. */
function deliverWhenReady(io, ctx) {
  return deliverTestRunsWhenReady(io, ctx, { withBoard, withBoardRead, whoAmI }, () => fileChangeWaiter([ctx.file, ctx.file + '-wal']));
}

/** Run `pullboard next` and return its exit code. */
export function run(io, { first, values }) {
  return nextHere(io, { ...values, verifyId: first });
}

/** Offer a capable seat the handoff a light seat needs, claiming nothing, so light work reaches light seats (#2973). */
function sayDiagnoseOffer(io, { diagnose: item, reasons }) {
  const id = item.item_id;
  io.result?.({ diagnose: { item_id: id, item_title: item.item_title }, item: null, reasons });
  io.say(`diagnose #${id}: ${item.item_title} is light work with no diagnosis, so no light seat can take it`);
  if (item.item_criterion) io.say(`criterion: ${item.item_criterion}`);
  if (item.item_check) io.say(`check: ${item.item_check}`);
  io.say(`next: read it with pullboard show ${id}, then record the handoff: pullboard fact ${id} diagnosis "Files: <exact paths> Change: <the exact fix> Test case: <the named case and assertion>"; then pullboard next`);
  io.say(`if it is not light work, build it yourself: pullboard claim ${id}`);
}
