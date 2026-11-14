import { landingFailureObservation } from '../../../../../packages/health/index.js';
import { replayLanding } from '../../../../../packages/landing/index.js';
import { replayLine } from '../../../../../packages/landing/index.js';
import { mainCheckout } from '../../../../../packages/git/index.js';
import { automaticLandingEnabled } from '../../../../../packages/merge/index.js';
import { primaryCheckoutRoot } from '../worktree.js';
import { mainPolicy } from '../../../../../packages/sandbox/index.js';
import { requireManualLanding } from '../../../../../packages/merge/index.js';
import { badgeCounts } from '../../../../view/index.js';
import { badgeDocuments } from '../../../../view/index.js';
import { pairPrefix } from '../../../../../packages/flakes/index.js';
/** The pullboard land command, in its own module so an item adding another command never edits these lines. */
import { landWhy } from '../../../../../packages/landing/index.js';
import { landWhyLines } from '../../../../../packages/landing/index.js';
import { withBoardRead } from '../board/read.js';
import { context } from '../read.js';
import * as store from '../../../../../packages/store/index.js';
import {
  COORDINATOR,
} from '../../../../../packages/config/index.js';
import {
  requirePersonChannel,
} from '../../../../../packages/person/index.js';
import {
  requireSignedPerson,
} from '../../../../../packages/person/index.js';
import {
  Refused,
} from '../../../../../packages/kernel/index.js';
import {
  randomUUID,
} from 'node:crypto';
import {
  actOn,
  ordered,
} from '../entry.js';

/** Run `pullboard land` and return its exit code. */
export async function run(io, { first, second, rest, values }) {
  if (values.why) {
    const ctx = context(io);
    const why = await withBoardRead(ctx, (board) => landWhy(board, ctx.clock.now()));
    if (values.json) io.result(why);
    else for (const line of landWhyLines(why)) io.say(line);
    return 0;
  }
  const act = (work) => actOn(io, work);
  return act(async (ctx, board, me) => {
  if (values.replay) {
    if (first || second || rest.length || values.due || values.adopt || values['dry-run'] || values.waive !== undefined || values.max !== undefined) throw new Refused('USAGE', 'pullboard land --replay [--since <time>] takes no other option');
    const rows = replayLanding(board, { since: values.since });
    io.result?.({ replay: rows });
    for (const row of rows) io.say(replayLine(row));
    if (!rows.length) io.say('no recorded landing batches to replay');
    return 0;
  }
  if (me.id !== COORDINATOR || !ctx.info.isMain) throw new Refused('COORDINATOR_ONLY', 'only the coordinator lands verified batches; ask your coordinator to run pullboard land');
  if (values.forced !== undefined) return offerForcedLanding(ctx, io, board, [first, second, ...rest], values);
  if (values.waive !== undefined) {
    if (first || second || rest.length || values.due || values.adopt || values.max !== undefined) throw new Refused('USAGE', 'pullboard land --waive <test> --until <date> --reason <why>');
    const confirmed = await requireSignedPerson(ctx, board, me, { verb: 'land-waive', args: { waive: String(values.waive), until: String(values.until ?? ''), reason: String(values.reason ?? '') } });
    if (confirmed !== null) return confirmed;
    requirePersonChannel(io.personChannel);
    const waiver = await ordered(ctx, board, 'recordLandingWaiver', [{ agentId: store.PERSON, channel: io.personChannel ?? 'terminal',
      id: randomUUID(), test: values.waive, until: values.until, reason: values.reason }]);
    io.result?.({ batch: null, landed: [], conflicts: [], blocked: [], culprits: [], flakes: [], waiver });
    io.say(`waived ${waiver.kind ?? store.landingWaiverKind(waiver.test)} ${waiver.test} until ${waiver.until}: ${waiver.reason}`);
    return 0;
  }
  // The land job is the one landing path: land offers it and runs no batch on this host (lander v2 section 3) [#6119].
  const batchOption = ['items', 'commit', 'dry-run', 'adopt', 'due', 'max', 'until', 'reason'].find(name => values[name] !== undefined && values[name] !== false);
  if (first || second || rest.length || batchOption) throw new Refused('LAND_OFFER_ONLY', `pullboard land only offers the land job${batchOption ? `; --${batchOption} ran the retired host batch` : ''}`, 'run pullboard land with no option, or land <id> --forced "<why>"');
  try { requireManualLanding(mainPolicy(ctx.info.root).config); } catch (error) {
    if (!(error instanceof Refused) || error.code !== 'BOARD_LANDS_ACCEPTED') throw error;
    // A 0.9.3 user ran land by hand; say what changed and the one setting that brings it back.
    throw new Refused('BOARD_LANDS_ACCEPTED', 'the board lands accepted items by itself: once an item is accepted, landing starts on its own, so pullboard land is no longer needed by hand', 'to land by hand as before, set landing.manualOverride to true in pullboard.json (the person sets it); otherwise run pullboard next for other work');
  }
  const offered = await offerLanding(ctx, ctx.info.root, { board });
  if (!offered) throw noLandingRunner();
  io.result?.(offered);
  if (!offered.offered) io.say('no verified items ready to land');
  return 0;
});
}

/** The refusal when no runner can take a land job: no trunk remote of record and no local runner on this machine. */
function noLandingRunner() {
  return new Refused('LAND_NO_RUNNER', 'a landing is a runner land job, and this board has no trunk remote of record and no local runner under pull dispatch', 'set trunk.remote in pullboard.json to the trunk\'s git URL, or use pull dispatch with gate.localRunner on in the machine settings');
}

/** Offer a runner land job from the main checkout (pull.js's offerPulledLanding), loaded only when a landing is offered. */
async function offerLanding(ctx, root, options = {}) {
  return (await import('../landing/pull.js')).offerPulledLanding(ctx, root, { mainPolicy, pairPrefix, listItems: store.listItems, checkedLandingCommit: store.checkedLandingCommit, badgeDocuments: board => badgeDocuments(badgeCounts(board)) }, options);
}

/**
 * `pullboard land <id>... --forced "<why>"`: offer the named items as the same land job kind as any landing, carrying
 * the forced reason, so a forced landing goes through the runner's merge, check and receipt-guarded push (#5864).
 */
async function offerForcedLanding(ctx, io, board, args, values) {
  const forced = String(values.forced ?? '').trim();
  const ids = args.filter(arg => arg !== undefined && arg !== null);
  if (!forced) throw new Refused('FORCED_REASON', 'a forced landing names why it went around the gate: --forced "<why>"');
  if (!ids.length || ids.some(id => !/^[1-9][0-9]*$/u.test(String(id)))) throw new Refused('USAGE', 'pullboard land <id> [<id>...] --forced "<why>"');
  const offered = await offerLanding(ctx, primaryCheckoutRoot(ctx.info), { ids: ids.map(Number), forced, board });
  if (!offered) throw noLandingRunner();
  io.result?.(offered);
  return 0;
}

/**
 * How long an accept's landing wake waits before it starts: none, so the lander starts the accepted item's landing at
 * once (the scheduler's own 1 s floor still applies). Why: a 10 s wait to gather accepts into one batch was a batching
 * delay, and batches hold one item (Corey 5 Nov); accepts made while a landing runs still go to that one worker [C7].
 */
export const LANDING_COALESCE_MS = 0;

/**
 * Offer the land job after acceptance; the caller catches this entire post-verdict effect. A runner merges and pushes,
 * so no session on this host lands anything (#2499). Returns the offer, or false (with the next step said) when
 * automatic landing is off or no runner can take the job [#6119].
 */
export async function landAfterAcceptance(ctx) {
  if (!mainCheckout(ctx.info.root)?.branch || !automaticLandingEnabled(mainPolicy(ctx.info.root).config)) return false;
  const root = primaryCheckoutRoot(ctx.info);
  // A runner lands, in any dispatch mode: this host offers one land job row and returns, and runs no batch [P7,#5864,#6119].
  const pulled = await offerLanding(ctx, root);
  if (pulled) return pulled;
  const refusal = noLandingRunner();
  ctx.io.say?.(`not landed: ${refusal.message}; next: ${refusal.next}`);
  return false;
}

/**
 * Whether a verified, unheld, unmerged item waits outside a batch that just ended blocked: work the next batch can take
 * at once. Why: after each blocked batch the lander backed off 1 to 4 minutes while #3862, never tried, waited [C7].
 *
 * @param {object[]} items - The board's items.
 * @param {object | undefined} batch - The batch this run ended with.
 * @returns {boolean}
 */
export function untriedAfter(items, batch) {
  if (batch?.state !== 'blocked') return false;
  const tried = new Set((batch.items ?? batch.candidates ?? []).map(entry => entry.id));
  return items.some(item => item.item_status === 'verified' && !item.item_merged_commit && !item.item_hold_at && !tried.has(item.item_id));
}

/** How long a landing waits before trying again while verified items still wait, when no cadence is set [C7]. */
export const LANDING_RETRY_MS = 30_000; // 5 min idled the lander after every blocked batch while 60 items waited [C7].

/** How soon the next batch starts after a run that landed or reopened items while others still wait [C7]. */
export const LANDING_NEXT_BATCH_MS = 1_000;

/**
 * Run one board write, waiting out a busy board lock with doubling backoff instead of ending the landing. Only the
 * refused write repeats, never the batch work before it. Why: board write locks are held for seconds (5.3 s at most
 * over 400 writes on 4 Nov), yet a BOARD_BUSY ended the landing and left accepted work idle until the next cycle; any
 * other refusal still ends the attempt (#3149).
 */
export async function untilBoardFree(work, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), say = () => {}, pauseMs = 1_000, maxPauseMs = 8_000, maxWaitMs = 120_000 } = {}) {
  for (let waited = 0, pause = pauseMs; ; pause = Math.min(pause * 2, maxPauseMs)) {
    try { return await work(); }
    catch (error) {
      // A stale flake-ratchet boundary is not a lock: the same snapshot can never be accepted while seats keep
      // writing, so the worker must recompute it (prepareFlakeLanding), not sleep; 2 minutes of sleeping ended a
      // worker and cost #3167 a second gate on 6 Nov [C7].
      if (error?.code !== 'BOARD_BUSY' || /flake evidence or repair status changed/u.test(error.message ?? '') || waited + pause > maxWaitMs) throw error;
      say(`landing met a busy board lock; waiting ${Math.round(pause / 1000)} s and continuing the same landing`);
      await wait(pause);
      waited += pause;
    }
  }
}

/**
 * When the board's next landing wake is due: within seconds after a run that moved work, else a recorded deferral, else one retry interval from now while verified,
 * unheld items are still waiting; null when nothing waits [C7,#2898].
 * Why: only an accept scheduled a landing, so a blocked batch left verified work idle until the next accept.
 */
export function landingRetryAt(result, now) {
  if (!result?.waiting) return null;
  // A run that moved work (landed it, or reopened a conflict or culprit) starts the next batch at once while verified
  // items wait, ahead of any deferral: the lander sat idle about 65% of the time waiting a full interval after every
  // landing (#3149). A run that moved nothing keeps its deferral or the interval, so a refusal that stays put never
  // loops hot.
  // A batch that ended blocked tried its items; the next batch takes the untried ones behind it at once [C7].
  const moved = result?.stalled === true || result?.landed?.length > 0 || result?.conflicts?.length > 0 || result?.culprits?.length > 0 || result?.reopened > 0
    || result?.batch?.state === 'blocked' && result.untried === true;
  if (moved && result.waiting) return new Date(now + LANDING_NEXT_BATCH_MS).toISOString();
  if (result?.deferredUntil) return result.deferredUntil;
  return result?.waiting ? new Date(now + (result.retryMs ?? LANDING_RETRY_MS)).toISOString() : null;
}

/**
 * Use the existing ordered health move so a refusal reaches the inbox without a new replay effect. A notice never
 * blocks or repeats a landing: a HEALTH_SCAN_STALE refusal (the board moved between the read and the move) reads
 * the observation again once, and any other failure is logged and dropped, as on 9 Nov [C7].
 * `write` is the ordered-move port, so a test drives the notice against a real board without the CLI's transport.
 */
export async function recordLandingNotices(ctx, board, io, write = (operation, args) => ordered(ctx, board, operation, args)) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const observation = landingFailureObservation(board);
      if (observation) await write('recordHealthFindings', [{ agentId: 'coordinator', ...observation }]);
      return;
    } catch (error) {
      if (error?.code === 'HEALTH_SCAN_STALE' && attempt === 0) continue;
      io.err?.('landing refusal notice deferred: ' + (error.code ?? 'ERROR'));
      return;
    }
  }
}
