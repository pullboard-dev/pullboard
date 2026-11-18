/** Ordered board admission serializes one trunk independently of machine test capacity [Q1,Q2,Q3]. */
import {
  atomic,
  coordinatorHolder,
  logEvent,
} from "../../../io/board.js";
import { COORDINATOR } from "../../../../../config/index.js";
import { strictFullSuiteEnabled } from "../../../../../config/index.js";
import { Refused } from "../../../../../kernel/light.js";
import { RELEASE_REASONS } from "../../reasons.js";
import { staleStateLimits } from "../stale/state/policy.js";
import { AGENT_GRANT_ENGINE } from "../../../../../state/light.js";
import { MOVES } from "../../../../../state/index.js";
import { causeProblem } from "../rigor.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { LANDING_LOCAL_LEASE_ENGINE } from "../../../../../state/light.js";
import { LANDING_FAULT_CODES } from './limits.js';
import { LANDING_RED_LIMIT } from './limits.js';
import { REPEATED_LANDING_HOLD } from './limits.js';
import { RUNNER_SOURCE_RETRIES } from './limits.js';
import {
  localLandingEntry,
  rememberLocalLanding,
} from "./local.js";

const KEY = 'landing_lease';
let provided = null;
/**
 * Hand the store the move-table engines it runs: leaseEngine, releaseEngine, withdrawEngine, claimEngine, submitEngine, reopenEngine, verifyEngine, landingEngine, pulledEngine, reclaimEngine and runTable.
 * Why injection: the moves cell already reads the store, so the store importing moves would close a cell cycle; the board composition root, which sees both, calls this once [C7].
 *
 * @param {{ leaseEngine: Function, releaseEngine: Function, withdrawEngine: Function, claimEngine: Function, submitEngine: Function, reopenEngine?: Function, verifyEngine?: Function, landingEngine?: Function, pulledEngine?: Function, runTable: Function }} engines
 */
export function provideMoveTables(engines) { provided = Object.freeze({ ...engines }); }
/** The injected engines; a store used without its composition root refuses by name. */
function moveTables() {
  if (!provided) throw new Refused('MOVE_TABLES_MISSING', 'the store runs its move tables through the board composition root; open the board through packages/board or call provideMoveTables first');
  return provided;
}
let withdrawBuilt = null;
/** Run the withdraw table over a snapshot and a move; `from` is the lifecycle machine's list of states a withdrawal may start from [C7,#8273]. */
export function runWithdrawTable(from, snapshot, move) {
  withdrawBuilt ??= moveTables().withdrawEngine({ from });
  return moveTables().runTable(withdrawBuilt.table, withdrawBuilt.rules, snapshot, move);
}


let claimTable = null;
/**
 * Run the claim and renew move table over a snapshot and move.
 * Why here: this file is the store's one reader of the moves cell, so the claim writer reaches the table without a second cross-cell edge [C7,#8270].
 */
export function runClaimTable(snapshot, move) {
  claimTable ??= moveTables().claimEngine({ grantEngine: AGENT_GRANT_ENGINE });
  return moveTables().runTable(claimTable.table, claimTable.rules, snapshot, move);
}
let verifyBuilt = null;
/**
 * Run the verify move table over a snapshot and move; `build` yields the engine's inputs and is called once, at first use.
 * Why here: this file is the store's one reader of the moves tables, so the verify writer reaches the table without a second cross-cell edge [C7,#8272].
 */
export function runVerifyTable(build, snapshot, move) {
  verifyBuilt ??= moveTables().verifyEngine(build());
  return moveTables().runTable(verifyBuilt.table, verifyBuilt.rules, snapshot, move);
}
/**
 * Whether landing.strictFullSuite is on, read from the machine settings at the call.
 * Why here: this file already holds the store's config edge for landing, so the merged writer reads the setting without a new cell import [M2,#9327].
 */
export function strictFullSuiteOn() { return strictFullSuiteEnabled(); }
let mergedBuilt = null;
/**
 * Run the landing merged table over a snapshot and move, built on first use over the landing's own limits, fault codes and repeat-hold prefix.
 * Why here: this file is the store's one reader of the moves tables, so the merged writer reaches the table without a second cross-cell edge [C7,#8268].
 */
export function runMergedTable(snapshot, move) {
  mergedBuilt ??= moveTables().landingEngine({ limits: { redLimit: LANDING_RED_LIMIT, runnerSourceRetries: RUNNER_SOURCE_RETRIES, staleProbes: 8 }, faultCodes: LANDING_FAULT_CODES, repeatHold: REPEATED_LANDING_HOLD });
  return moveTables().runTable(mergedBuilt.tables.merged, mergedBuilt.rules, snapshot, move);
}
/**
 * Run the landing-pulled table over a snapshot and move, the table the board root hands over as pulledEngine.
 * Why here: this file is the store's one reader of the moves tables, so the pulled writer reaches the table without a second cross-cell edge [M2,R3,#9098].
 */
export function runPulledTable(snapshot, move) {
  const { table, rules } = moveTables().pulledEngine();
  return moveTables().runTable(table, rules, snapshot, move);
}
/**
 * Run the reclaim table over a snapshot and move, the table the board root hands over as reclaimEngine.
 * Why here: this file is the store's one reader of the moves tables, so the maintenance writer reaches the table without a second cross-cell edge [C7,#9367].
 */
export function runReclaimTable(snapshot, move) {
  const { table, rules } = moveTables().reclaimEngine();
  return moveTables().runTable(table, rules, snapshot, move);
}
let reopenBuilt = null;
/**
 * Run the reopen move table over a snapshot and move, built on first use over the board's own cause check and the states its machine lets a reopen start from.
 * Why here: this file is the store's one reader of the moves tables, so the reopen writer reaches the table without a second cross-cell edge [C7,#8388].
 */
export function runReopenTable(snapshot, move) {
  const { reopenEngine } = moveTables();
  if (reopenBuilt?.engine !== reopenEngine) reopenBuilt = { engine: reopenEngine, ...reopenEngine({ causeProblem, states: MOVES.find(entry => entry.verb === 'reopen').from }) };
  return moveTables().runTable(reopenBuilt.table, reopenBuilt.rules, snapshot, move);
}
export const LANDING_LEASE_MS = 120_000; // 30 s died under a 22 s board write; a dead holder is still reclaimed at expiry [C7].

/** Validate every queue identity before it becomes durable or controls admission. */
function validEntry(entry) {
  return entry && /^[a-f0-9-]{36}$/u.test(entry.token ?? '') && typeof entry.branch === 'string' && entry.branch.length > 0
    && entry.branch.length <= 256 && typeof entry.label === 'string' && entry.label.length > 0 && entry.label.length <= 160
    && !/[\r\n]/u.test(entry.label) && Number.isSafeInteger(entry.pid) && entry.pid > 0
    && (entry.lineage === null || typeof entry.lineage === 'string' && entry.lineage.length > 0 && entry.lineage.length <= 64)
    && (entry.guardianPid === undefined || Number.isSafeInteger(entry.guardianPid) && entry.guardianPid > 0)
    && Number.isFinite(Date.parse(entry.until)) && Number.isFinite(Date.parse(entry.since));
}

/** The lease table over this file's 120 s rule and entry check, built on first use so the moves cell is never read while it loads. */
let engine;
const leaseTable = () => engine ??= moveTables().leaseEngine({ leaseMs: LANDING_LEASE_MS, valid: validEntry });

let release;
/**
 * Run the release move table over a snapshot and a move; the table is built on first use over the board's own reasons and stale limits.
 * Why here: this file is the store's one reader of the moves cell, so the release writer reaches the table without a second cross-cell edge [C7,#8246].
 *
 * @param {object} snapshot
 * @param {object} move
 * @returns {{ refused?: object, patch?: object, events?: object[], via?: string[] }}
 */
export function runReleaseTable(snapshot, move) {
  const { rules, table } = release ??= moveTables().releaseEngine({ reasons: RELEASE_REASONS, staleLimits: staleStateLimits });
  return moveTables().runTable(table, rules, snapshot, move);
}

/**
 * Run one lease move through the table over the queue and the board's clock and lineage; a refusal throws as the same code and words.
 * Why the wall-clock fallback: the landing guardian reads the queue through a bare `{ db }` with no clock, and the table rewrite threw there
 * (swallowed as "nothing to renew"), so the guardian never renewed a heartbeat [C7,#5770].
 */
function leaseMove(board, state, move, over = {}) {
  const { rules, table } = leaseTable();
  const snapshot = { lease: structuredClone(state), now: (board.clock?.now() ?? new Date()).getTime(), lineage: 'lineage' in over ? over.lineage : coordinatorHolder(board)?.lineage ?? null,
    modern: (board.executionEngineVersion ?? ENGINE_VERSION) >= LANDING_LOCAL_LEASE_ENGINE, shared: true, legacyShared: false, heartbeat: null, ...over };
  const answer = moveTables().runTable(table, rules, snapshot, move);
  if (answer.refused) throw new Refused(answer.refused.code, answer.refused.message);
  return answer;
}


/** Read the durable queue without treating a corrupt record as an unoccupied trunk; the table decides whether it is whole. */
function sharedLandingLeaseState(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(KEY);
  if (!row) return { generation: 0, holder: null, line: [] };
  let state;
  try { state = JSON.parse(row.meta_value); } catch { state = null; }
  leaseMove(board, state, { name: 'inspect' }, { lineage: null });
  return state;
}

/** Overlay only physical-board heartbeats; shared replay always reads the unmodified queue. */
export function landingLeaseState(board) {
  const state = sharedLandingLeaseState(board);
  const local = entry => entry && { ...entry, until: localLandingEntry(board, entry)?.until ?? entry.until };
  return { ...state, holder: local(state.holder), line: state.line.map(local) };
}

/**
 * Renew an acknowledged invocation locally; this function never calls a relay or creates a grant.
 * Why no policy snapshot: renewal is a heartbeat, not a policy-judged move; a policy change landing mid-renewal killed the landing (#5672).
 */
export function renewLocalLanding(board, fence) {
  return atomic(board, () => {
    const holder = assertLandingLease(board, fence);
    if (!localLandingEntry(board, holder)) throw new Refused('LAND_LEASE_LOST', 'this invocation has no acknowledged local landing grant; run pullboard land again');
    const renewed = { ...holder, until: new Date(board.clock.now().getTime() + LANDING_LEASE_MS).toISOString() };
    rememberLocalLanding(board, renewed);
    if (holder.lineage === null) {
      const state = sharedLandingLeaseState(board);
      state.holder = renewed;
      save(board, state, 'renew', holder.token, false);
    }
    return renewed;
  }, { writePolicy: false }); // A heartbeat reads no accepted policy, so a policy landing mid-renewal never refuses it (#5672).
}

/** A fence must still identify the current, unexpired holder under the current coordinator; the lease table judges it. */
export function assertLandingLease(board, fence, { shared = false } = {}) {
  requireConfirmedLanding(board);
  const state = shared ? sharedLandingLeaseState(board) : landingLeaseState(board);
  const heartbeat = !shared && localLandingEntry(board, state.holder);
  const legacyShared = shared && (board.executionEngineVersion ?? ENGINE_VERSION) < LANDING_LOCAL_LEASE_ENGINE;
  leaseMove(board, state, { name: 'assert', token: fence?.token, generation: fence?.generation, branch: fence?.branch }, { shared, legacyShared, heartbeat: heartbeat || null });
  return state.holder;
}

/** Pending local intents are not authority to merge, push or move the trunk (#1013 integration boundary). */
export function requireConfirmedLanding(board) {
  if (board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key GLOB 'relay_local_intent_*' LIMIT 1").get()) {
    throw new Refused('RELAY_CONFIRMATION_PENDING', 'this board has local moves awaiting relay confirmation; land after their ordered receipts arrive');
  }
}

/** Refuse an unowned new batch write while another invocation holds the trunk. */
export function guardLandingWrite(board, fence) {
  if (fence || landingLeaseState(board).holder) assertLandingLease(board, fence);
}

/** Persist a complete queue transition and a compact, append-only admission receipt. */
function save(board, state, action, token, event = true, reason = null, backoffMs = undefined) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(KEY, JSON.stringify(state));
  if (event) logEvent(board, COORDINATOR, 'landing_lease', null, { action, token, holder: state.holder?.label ?? null, generation: state.generation, queued: state.line.length, ...(reason ? { reason } : {}), ...(Number.isSafeInteger(backoffMs) ? { backoffMs } : {}) });
}

/** Enqueue, renew, inspect ownership or release through one deterministic ordered operation. */
export function landingLeaseMove(board, { agentId, action, token, branch, pid, generation, guardianPid, reason, backoffMs }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator takes a landing lease; ask your coordinator to run pullboard land');
  if (!['request', 'renew', 'release', 'bind'].includes(action) || !/^[a-f0-9-]{36}$/u.test(token ?? '')) {
    throw new Refused('LAND_LEASE_REQUEST', 'a landing lease needs its command identity and a supported action; run pullboard land');
  }
  // A request made after a back-off names the wait that delayed it, at most the lander's five-minute ceiling [C7].
  if (backoffMs !== undefined && backoffMs !== null && !(Number.isSafeInteger(backoffMs) && backoffMs > 0 && backoffMs <= 300_000)) {
    throw new Refused('LAND_LEASE_REQUEST', 'a landing lease request names its back-off as whole milliseconds up to five minutes; run pullboard land');
  }
  return atomic(board, () => {
    if (action === 'renew' || action === 'bind') requireConfirmedLanding(board);
    const state = sharedLandingLeaseState(board);
    const modern = (board.executionEngineVersion ?? ENGINE_VERSION) >= LANDING_LOCAL_LEASE_ENGINE;
    const transition = value => JSON.stringify([value.generation, value.holder?.token ?? null, value.line.map(entry => entry.token)]);
    const previousTransition = transition(state);
    const before = JSON.stringify(state);
    if (action === 'request') requireConfirmedLanding(board);
    const holder = action === 'request' ? coordinatorHolder(board) : null;
    const answer = leaseMove(board, state, { name: action, token, branch, pid, generation, guardianPid, label: holder?.label, lineage: holder?.lineage ?? null, machine: holder?.machine ?? null });
    const next = answer.patch.lease;
    state.generation = next.generation;
    state.holder = next.holder;
    state.line = next.line;
    if (JSON.stringify(state) !== before) save(board, state, action, token, !modern || transition(state) !== previousTransition, action === 'release' && typeof reason === 'string' ? reason.slice(0, 120) : null,
      action === 'request' ? backoffMs ?? undefined : undefined);
    return { holder: state.holder, position: state.line.findIndex(entry => entry.token === token) + 1,
      acquired: state.holder?.token === token, generation: state.holder?.token === token ? state.holder.generation : null };
  });
}

let submitTables = null;
/**
 * Run one submit-family table (SUBMIT, COMMIT, OUTCOME, START or COMPLETE) over a snapshot and move.
 * Why here: this file is the store's one reader of the moves cell; the caller passes the retry limit and infrastructure codes, as the tables take them by injection [C7,#8271].
 *
 * @param {'SUBMIT' | 'COMMIT' | 'OUTCOME' | 'START' | 'COMPLETE'} name
 * @param {{ retryLimit: number, infrastructureCodes: Iterable<string> }} limits
 * @returns {{ refused?: object, patch?: object, events?: object[], via?: string[], table: object }}
 */
export function runSubmitTable(name, limits, snapshot, move) {
  submitTables ??= moveTables().submitEngine(limits);
  const table = submitTables.tables[name];
  return { ...moveTables().runTable(table, submitTables.rules, snapshot, move), table };
}
