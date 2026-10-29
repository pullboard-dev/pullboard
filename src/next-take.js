import { setImmediate as yieldNext } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { mainRedBuildRouting } from './main-red-build-routing.js';
/** Current-seat dispatch shares board eligibility with the heartbeat warning [N2,V1,B3]. */
import * as store from './board.js';
import { dispatchWork } from './dispatch-eligibility.js';
import {
  nextReview,
  ownSessionReviews,
} from './next-review.js';
import { headCommit } from './git.js';
import { trunkMerge } from './trusted-policy.js';
import { Refused } from './refused.js';

/** Resolve current-seat eligibility on either a read snapshot or the final ordered writer. */
function selected(ctx, board, values, { checkMainVerifier, whoAmI, mainRedReworkItems, mainRedReviewItems }) {
  checkMainVerifier(ctx, board, values);
  const me = whoAmI(ctx, board);
  const routing = mainRedBuildRouting(board, { priority: mainRedReworkItems(ctx.info.root, board), caller: me.id, runnable: values.runnable, routes: values.routes });
  if (routing) {
    if (routing.buildOffer?.seat === me.id) return { item: routing.item, reasons: routing.reasons, review: false, held: false };
    return { ...routing, review: false, held: false };
  }
  return dispatchWork(board, store.agentById(board, me.id), {
    policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family,
    skipIds: ownSessionReviews(ctx.info, board, undefined, { listItems: store.listItems }), priority: mainRedReviewItems(ctx.info.root, board), observeIdle: values.observeIdle,
  });
}

/** Preview whether ordinary next needs the main-red build routing path; no move or worktree is written. */
export function mainRedBuildOffer(ctx, values = {}, { withBoardRead, whoAmI, mainRedReworkItems }) {
  return withBoardRead(ctx, board => {
    const me = whoAmI(ctx, board);
    return mainRedBuildRouting(board, { priority: mainRedReworkItems(ctx.info.root, board), caller: me.id, runnable: values.runnable, routes: values.routes });
  });
}

/** Take one eligible review or build through existing ordered guards, without routing to another seat. */
export async function nextTake(ctx, values = {}, services) {
  const { MainSpecMerged, claimFreezer, claimOrdered, idArg, ordered, whoAmI, withBoard, withBoardRead,
    computedReturnArgs, mainRedReviewItems } = services;
  const looked = withBoardRead(ctx, board => selected(ctx, board, values, services));
  if (!looked.item || looked.buildOffer || looked.releaseRequest || looked.held && !looked.review) return looked;
  return await withBoard(ctx, async board => {
    const picked = selected(ctx, board, values, services);
    const me = whoAmI(ctx, board);
    if (picked.buildOffer || picked.releaseRequest || picked.held && !picked.review || !picked.item) return picked;
    ctx.io.nextPhase?.(picked.review ? 'review reservation' : 'claim', picked.item.item_id);
    if (picked.review) {
      const reviewed = await nextReview(ctx, board, me, values, {
        ordered: (operation, args) => ordered(ctx, board, operation,
          operation === 'reopen' ? computedReturnArgs(board, args) : args), idArg, trunkMerge,
        listItems: store.listItems, itemById: store.itemById, getItem: store.getItem, mainRedReviewItems,
      });
      // Conflict preflight may have returned the selected review; re-read eligibility before building.
      return reviewed.item ? { ...reviewed, review: true } : { ...reviewed, retry: true, retryDetail: { phase: 'review reservation', item: picked.item.item_id, code: 'NO_REVIEW_RESERVED' } };
    }
    try {
      await claimOrdered(ctx, board, [picked.item.item_id, {
        agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs,
        freeze: claimFreezer(ctx, board), head: headCommit(ctx.info.root),
      }]);
    } catch (error) {
      if (error instanceof MainSpecMerged) return { retry: true, specMerged: { item: picked.item.item_id, rows: error.rows } };
      // A peer taking the selected item is a normal queue race; a held-seat refusal stays actionable.
      if (error instanceof Refused && ['HELD', 'ITEM_HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) return { retry: true, retryDetail: { phase: 'claim', item: picked.item.item_id, code: error.code, message: error.message } };
      throw error;
    }
    return { ...picked, item: store.getItem(board, picked.item.item_id), review: false };
  });
}

/** Bound active routing retries while yielding so native progress and peer work can run [C7,1811]. */
export function nextProgress(io, { timeoutMs = 60_000, phaseMs = 10_000, maxRetries = 16, now = () => performance.now(), monitor = null } = {}) {
  // Budget: #1811 allows one minute of active routing and names a phase after ten seconds.
  let started = now(), lastIdleNotice = -Infinity;
  let phase = 'startup', item = null, phaseStarted = started, timer = null, warned = false, retries = 0;
  const repeated = new Map();
  /** Keep progress off JSON stdout and retain the actual known item, not an invented candidate. */
  function line() {
    const text = `next phase ${phase}; item ${item === null ? 'not yet selected' : '#' + item}; ${Math.round(now() - phaseStarted)} ms`;
    if (io.stderr?.write) io.stderr.write(text + '\n'); else io.err?.(text);
  }
  /** Print one delayed line for the current phase; a retry yields to this timer. */
  function warn() { if (!warned) { warned = true; if (monitor) monitor.warn(); else line(); } }
  /** Stop a completed phase's timer without touching a native operation or its claim. */
  function stop() { if (timer) clearTimeout(timer); timer = null; monitor?.stop(); }
  /** Name the next real phase and its item before entering potentially slow work. */
  function enter(name, id = null) {
    check();
    stop(); phase = name; item = Number.isSafeInteger(id) ? id : null; phaseStarted = now(); warned = false;
    if (monitor) monitor.enter(phase, item);
    else { timer = setTimeout(warn, phaseMs); timer.unref?.(); }
  }
  /** Refuse only between completed native attempts, preserving any committed claim's custody. */
  function check() {
    if (now() - phaseStarted >= phaseMs) warn();
    if (now() - started >= timeoutMs) throw new Refused('NEXT_TIMEOUT',
      `next exceeded its active routing budget in ${phase}; item ${item === null ? 'not yet selected' : '#' + item}; inspect your current claim or review before retrying`);
  }
  /** Observe an actual phase and check its completed result; never race an ordered write against a timer. */
  async function run(name, id, work) {
    enter(name, id);
    try { const value = await work(); check(); return value; }
    finally { stop(); }
  }
  /** Retry transient peer races finitely; an unchanged refusal cannot create a microtask/SQLite spin. */
  async function retry(found) {
    const detail = found.retryDetail ?? { phase: 'routing retry', item: null, code: 'NO_REVIEW_RESERVED' };
    enter(detail.phase, detail.item);
    const key = JSON.stringify([detail.phase, detail.item, detail.code]);
    const count = (repeated.get(key) ?? 0) + 1;
    repeated.set(key, count); retries++;
    try {
    check();
    if (count >= 3 || retries >= maxRetries) {
      stop();
      throw new Refused('NEXT_TIMEOUT', `next made no progress in ${phase}; item ${item === null ? 'not yet selected' : '#' + item}; ${detail.code}${detail.message ? ': ' + detail.message : ''}; inspect your current claim or review before retrying`);
    }
    await yieldNext();
    check();
    } finally { stop(); }
  }
  /** Deliberate --wait sleep is not active routing; retain its wall-clock deadline in the caller. */
  async function idle(reasons, work) {
    check(); stop();
    if (now() - lastIdleNotice >= 60_000) {
      lastIdleNotice = now();
      const reason = reasons?.length ? reasons.join('; ').replace(/[\r\n]+/gu, ' ') : 'eligible work in this lane';
      const text = `next waiting for ${reason}; no item selected`;
      if (io.stderr?.write) io.stderr.write(text + '\n'); else io.err?.(text);
    }
    try { return await work(); }
    finally { started = now(); phaseStarted = started; retries = 0; repeated.clear(); }
  }
  return { enter, run, retry, idle, stop };
}
