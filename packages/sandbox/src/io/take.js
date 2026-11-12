import {
  setImmediate as yieldNext,
  setTimeout as pause,
} from 'node:timers/promises';
import {
  performance,
} from 'node:perf_hooks';
import {
  mainRedBuildRouting,
} from '../../../store/index.js';
/** Current-seat dispatch shares board eligibility with the heartbeat warning [N2,V1,B3]. */
import * as store from '../../../store/index.js';
import {
  dispatchWork,
} from '../../../store/index.js';
import {
  nextReview,
  ownSessionReviews,
} from '../../../verify/index.js';
import {
  headCommit,
} from '../../../git/index.js';
import {
  trunkMerge,
} from './trusted/policy.js';
import {
  Refused,
} from '../../../kernel/index.js';
import { COORDINATOR } from '../../../config/index.js';

/** Resolve current-seat eligibility on either a read snapshot or the final ordered writer. */
function selected(ctx, board, values, services) {
  const { checkMainVerifier, whoAmI, mainRedReworkItems, mainRedReviewItems, agentSessionDigest } = services;
  checkMainVerifier(ctx, board, values);
  const me = whoAmI(ctx, board);
  /** Builds never wait on review cover; the backlog is shouted to the coordinator when the build is claimed [#3792]. */
  const withCover = found => found;
  // A seat already holding a claim never takes the mandatory first review, so it skips that offer (#2978).
  const holding = store.listItems(board).some(item => item.item_status === 'claimed' && item.item_owner === me.id
    && !store.pendingSubmitHandoff(board, item));
  const mandatory = holding ? null : takeSelection.reviewOffer(board, { agentId: me.id, lane: me.lane, mandatoryOnly: true,
    policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family,
    skipIds: ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems: store.listItems }) });
  if (mandatory?.mandatory) return { item: mandatory.item, review: true, held: false, reasons: [] };
  // Items this call already passed over (an unbuildable bar, #5786) are never selected again.
  const omitted = values.omitIds ?? [];
  const routing = mainRedBuildRouting(board, { priority: mainRedReworkItems(ctx.info.root, board).filter(id => !omitted.includes(id)), caller: me.id, runnable: values.runnable, routes: values.routes,
    workingFiles: services.claimWorktrees && (() => services.claimWorktrees(store.listItems(board), store.listAgents(board), board)) });
  if (routing) {
    if (routing.buildOffer?.seat === me.id) return withCover({ item: routing.item, reasons: routing.reasons, review: false, held: false });
    return { ...routing, review: false, held: false };
  }
  return withCover(dispatchWork(board, store.agentById(board, me.id), {
    policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family,
    skipIds: ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems: store.listItems }), priority: mainRedReviewItems(ctx.info.root, board), observeIdle: values.observeIdle,
    assignedIds: omitted, workingFiles: services.claimWorktrees?.(store.listItems(board), store.listAgents(board), board),
    reviewHeartbeats: new Map(store.listAgents(board).map(({ agent_id, heartbeatAt }) => [agent_id, heartbeatAt])),
    releaseCooldown: { minutes: ctx.config.claims?.releaseCooldownMinutes ?? 30, now: ctx.clock.now().getTime() },
  }));
}

/** Preview whether ordinary next needs the main-red build routing path; no move or worktree is written. */
export function mainRedBuildOffer(ctx, values = {}, { withBoardRead, whoAmI, mainRedReworkItems, claimWorktrees, agentSessionDigest }) {
  return withBoardRead(ctx, board => {
    const me = whoAmI(ctx, board);
    if (store.reviewOffer(board, { agentId: me.id, lane: me.lane, mandatoryOnly: true, policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family,
      skipIds: agentSessionDigest ? ownSessionReviews(ctx.info, board, agentSessionDigest(), { listItems: store.listItems }) : [] })?.mandatory) return null;
    return mainRedBuildRouting(board, { priority: mainRedReworkItems(ctx.info.root, board), caller: me.id, runnable: values.runnable, routes: values.routes,
      workingFiles: claimWorktrees && (() => claimWorktrees(store.listItems(board), store.listAgents(board), board)) });
  });
}

/**
 * Close open Main red items whose test the newest recorded main run shows passing, so no builder claims them. The closing
 * goes through the ordinary withdraw move as the coordinator and cites the recorded run; it adds no test run.
 */
export async function closePassingMainReds(ctx, { passingMainRedItems, withBoard, withBoardRead, ordered }) {
  if (!passingMainRedItems) return;
  const passing = withBoardRead(ctx, board => passingMainRedItems(ctx.info.root, store.listItems(board)));
  if (!passing.length) return;
  await withBoard(ctx, async board => {
    const open = new Set(store.listItems(board).filter(item => item.item_status === 'open').map(item => item.item_id));
    for (const row of passing.filter(entry => open.has(entry.item))) {
      await ordered(ctx, board, 'withdraw', [row.item, { agentId: COORDINATOR,
        reason: `${row.file} already passes on main ${row.main.slice(0, 12)} (recorded run ${row.receiptId}); fixed by the landing ${(row.turnedGreen ?? row.main).slice(0, 12)}${row.landing ? ` "${row.landing}"` : ''} that turned it green; closed without a builder` }]);
    }
  });
}

/** Claim refusals of a bar no build can satisfy: next and next --take pass over the item instead of stopping (#5709, #5786). */
export const UNBUILDABLE = new Set(['BAR_PATH_MISSING', 'CRITERION_PROVES_NOTHING']);

/**
 * Tell the coordinator once that next passed over an item no builder can satisfy [B7,B25,C7].
 *
 * Why: every seat's next skips the same item, so a note per call would flood the coordinator; a marker fact keyed on
 * the refusal keeps the report to one per bar, and an edit that changes what is missing is a new episode (#5709).
 */
export async function reportUnbuildableOnce(ctx, board, item, holder, refusal, ordered) {
  const text = JSON.stringify({ unbuildableBar: { code: refusal.code, message: refusal.message } });
  if (store.itemThread(board, item.item_id).some(entry => entry.type === 'fact' && entry.text === text)) return;
  try {
    await ordered(ctx, board, 'appendFact', [item.item_id, { agentId: holder.id, kind: 'note', text }]);
    await ordered(ctx, board, 'shout', [{ from: holder.id, to: COORDINATOR, lanes: [],
      // Short: the refusal's paste-ready next step can exceed a shout's length, and pullboard show <id> prints it.
      text: `next passes over #${item.item_id} (${refusal.code}): ${refusal.message.replace(/^\[[A-Z_]+\] /u, '').slice(0, 240)}; pullboard show ${item.item_id}` }]);
  } catch (error) {
    // A refused report must never stop the seat it only reports on.
    if (!/^[A-Z][A-Z_]+$/u.test(String(error?.code))) throw error;
  }
}

/** Take one eligible review or build through existing ordered guards, without routing to another seat. */
export async function nextTake(ctx, values = {}, services) {
  const { MainSpecMerged, claimFreezer, claimOrdered, idArg, ordered, whoAmI, withBoard, withBoardRead,
    computedReturnArgs, mainRedReviewItems, agentSessionDigest } = services;
  await closePassingMainReds(ctx, services);
  const ineligible = withBoardRead(ctx, board => store.ineligibleReleaseIds(board, whoAmI(ctx, board).id));
  values = { ...values, omitIds: [...new Set([...(values.omitIds ?? []), ...ineligible])] };
  // Select once, on the read snapshot; the write runs only the chosen item's own guards (#2978).
  const { me, ...looked } = withBoardRead(ctx, board => ({ ...takeSelection.selected(ctx, board, values, services), me: whoAmI(ctx, board) }));
  if (looked.releaseRequest) {
    if (looked.releaseRequest.seat !== me.id) return looked;
    try {
      await withBoard(ctx, board => ordered(ctx, board, 'release', [looked.releaseRequest.item, me.id,
        `Waiting claim preempted for urgent #${looked.item.item_id}; source remains in its worktree`, undefined, 'ROUTED_ELSEWHERE']));
    } catch (error) {
      // The waiting claim changed since the read; the retry selects again.
      if (!(error instanceof Refused)) throw error;
    }
    return { retry: true, retryDetail: { phase: 'urgent preemption', item: looked.item.item_id, code: 'WAITING_CLAIM_RELEASED' } };
  }
  if (!looked.item || looked.buildOffer || looked.held && !looked.review) return looked;
  if (!looked.review && (looked.item.item_lane !== me.lane || !store.ROUTES.includes(me.route)
    || !store.ROUTES.includes(looked.item.item_route) || !store.canTake(me.route, looked.item.item_route)))
    return { reasons: [`#${looked.item.item_id} is available in ${looked.item.item_lane} on the ${looked.item.item_route} route; this seat leaves it unclaimed`], idleReason: 'nothing-eligible' };
  return await withBoard(ctx, async board => {
    if (!looked.review && store.diagnoseWanted(board, looked.item, me.route)) return { diagnose: looked.item, reasons: looked.reasons ?? [] };
    ctx.io.nextPhase?.(looked.review ? 'review reservation' : 'claim', looked.item.item_id);
    if (looked.review) {
      let reviewed;
      try {
        reviewed = await nextReview(ctx, board, me, { ...values, verifyId: looked.item.item_id }, {
          ordered: (operation, args) => ordered(ctx, board, operation,
            operation === 'reopen' ? computedReturnArgs(board, args) : args), idArg, trunkMerge,
          listItems: store.listItems, itemById: store.itemById, getItem: store.getItem, mainRedReviewItems, agentSessionDigest,
        });
      } catch (error) {
        // Another reviewer, a conflict return or a cooldown changed the chosen review; the retry selects again.
        if (error instanceof Refused && ['REVIEW_HELD', 'NOT_SUBMITTED', 'REVIEW_COOLDOWN'].includes(error.code)) return { retry: true, retryDetail: { phase: 'review reservation', item: looked.item.item_id, code: error.code } };
        throw error;
      }
      return reviewed.item ? { ...reviewed, review: true } : { ...reviewed, retry: true, retryDetail: { phase: 'review reservation', item: looked.item.item_id, code: 'NO_REVIEW_RESERVED' } };
    }
    try {
      await claimOrdered(ctx, board, [looked.item.item_id, {
        agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs,
        freeze: claimFreezer(ctx, board), head: headCommit(ctx.info.root), autoNext: true,
      }]);
      if (!looked.held) await services.shoutReviewCoverStuck?.(ctx, board, (c, b, op, args) => ordered(c, b, op, args), me);
    } catch (error) {
      if (error instanceof MainSpecMerged) return { retry: true, specMerged: { item: looked.item.item_id, rows: error.rows } };
      // A peer taking the selected item is a normal queue race; a held-seat refusal stays actionable.
      if (error instanceof Refused && ['HELD', 'ITEM_HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) return { retry: true, retryDetail: { phase: 'claim', item: looked.item.item_id, code: error.code, message: error.message } };
      // A bar no build can satisfy is passed over as plain next does, and the coordinator hears once per bar (#5786).
      if (error instanceof Refused && UNBUILDABLE.has(error.code)) {
        await reportUnbuildableOnce(ctx, board, looked.item, me, error, ordered);
        ctx.io.say?.(`skipped #${looked.item.item_id}: ${error.message}`);
        return { retry: true, skipItem: looked.item.item_id, retryDetail: { phase: 'claim', item: looked.item.item_id, code: error.code, message: error.message } };
      }
      throw error;
    }
    return { ...looked, item: store.getItem(board, looked.item.item_id), review: false };
  });
}

/**
 * The selection seam of next --take: it selects once per loop, and tests count these calls (#2978).
 * Each entry forwards to the real board selection.
 */
export const takeSelection = {
  /** Resolve this seat's work on one board snapshot. */
  selected: (ctx, board, values, services) => selected(ctx, board, values, services),
  /** Offer one review to this seat. */
  reviewOffer: (board, who) => store.reviewOffer(board, who),
};

/** Bound active routing retries while yielding so native progress and peer work can run [C7,1811]. */
export function nextProgress(io, { timeoutMs = 60_000, phaseMs = 10_000, maxRetries = 16, now = () => performance.now(), monitor = null } = {}) {
  // Budget: #1811 allows one minute of active routing and names a phase after ten seconds.
  let started = now(), lastIdleNotice = -Infinity;
  let phase = 'startup', item = null, phaseStarted = started, timer = null, warned = false, retries = 0;
  const repeated = new Map();
  // Profile: every millisecond since started belongs to exactly one named span, so the spans add up to the wall time [N2].
  const spans = []; let cursor = started, label = 'startup';
  /** Close the span that has been running since the last cut. */
  function cut(next) { const at = now(); spans.push({ phase: label, ms: at - cursor }); cursor = at; label = next; }
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
    cut(name); stop(); phase = name; item = Number.isSafeInteger(id) ? id : null; phaseStarted = now(); warned = false;
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
    finally { stop(); cut('between phases'); }
  }
  /** Retry transient peer races finitely; an unchanged refusal cannot create a microtask/SQLite spin. */
  async function retry(found, { until = null, rest = 2_000 } = {}) {
    const detail = found.retryDetail ?? { phase: 'routing retry', item: null, code: 'NO_REVIEW_RESERVED' };
    enter(detail.phase, detail.item);
    const key = JSON.stringify([detail.phase, detail.item, detail.code]);
    const count = (repeated.get(key) ?? 0) + 1;
    repeated.set(key, count); retries++;
    try {
    check();
    if ((count >= 3 || retries >= maxRetries) && until !== null && Date.now() < until) {
      stop(); repeated.clear(); retries = 0;
      await pause(rest);
      started = now(); phaseStarted = started;
      return;
    }
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
  /** Phase milliseconds so far, repeated phases summed, slowest first; the last span is closed at this call. */
  function profile() {
    cut(label);
    const total = new Map();
    for (const span of spans) total.set(span.phase, (total.get(span.phase) ?? 0) + span.ms);
    return [...total].map(([name, ms]) => ({ phase: name, ms })).sort((a, b) => b.ms - a.ms);
  }
  return { enter, run, retry, idle, stop, profile };
}
