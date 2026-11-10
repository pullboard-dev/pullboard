/** Ordered board admission serializes one trunk independently of machine test capacity [Q1,Q2,Q3]. */
import {
  atomic,
  logEvent,
} from "../../../io/board.js";
import { COORDINATOR } from "../../../../../config/index.js";
import { coordinatorHolder } from "../../../../../seats/browser.js";
import { Refused } from "../../../../../kernel/light.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { LANDING_LOCAL_LEASE_ENGINE } from "../../../../../state/light.js";
import {
  localLandingEntry,
  rememberLocalLanding,
} from "./local.js";

const KEY = 'landing_lease';
export const LANDING_LEASE_MS = 120_000; // 30 s died under a 22 s board write; a dead holder is still reclaimed at expiry [C7].

/** Read the durable queue without treating a corrupt record as an unoccupied trunk. */
function sharedLandingLeaseState(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(KEY);
  if (!row) return { generation: 0, holder: null, line: [] };
  try {
    const state = JSON.parse(row.meta_value);
    if (!Number.isSafeInteger(state.generation) || state.generation < 0 || !Array.isArray(state.line)
      || state.holder && (!Number.isSafeInteger(state.holder.generation) || state.holder.generation < 1 || state.holder.generation !== state.generation)
      || [state.holder, ...state.line].filter(Boolean).some(entry => !validEntry(entry))
      || new Set([state.holder, ...state.line].filter(Boolean).map(entry => entry.token)).size !== state.line.length + Number(Boolean(state.holder))) throw new Error('invalid landing queue');
    return state;
  } catch { throw new Refused('LAND_LEASE_CORRUPT', 'the landing queue is unreadable; restore the board from a consistent export before landing'); }
}

/** Overlay only physical-board heartbeats; shared replay always reads the unmodified queue. */
export function landingLeaseState(board) {
  const state = sharedLandingLeaseState(board);
  const local = entry => entry && { ...entry, until: localLandingEntry(board, entry)?.until ?? entry.until };
  return { ...state, holder: local(state.holder), line: state.line.map(local) };
}

/** Renew an acknowledged invocation locally; this function never calls a relay or creates a grant. */
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
  });
}

/** Validate every queue identity before it becomes durable or controls admission. */
function validEntry(entry) {
  return entry && /^[a-f0-9-]{36}$/u.test(entry.token ?? '') && typeof entry.branch === 'string' && entry.branch.length > 0
    && entry.branch.length <= 256 && typeof entry.label === 'string' && entry.label.length > 0 && entry.label.length <= 160
    && !/[\r\n]/u.test(entry.label) && Number.isSafeInteger(entry.pid) && entry.pid > 0
    && (entry.lineage === null || typeof entry.lineage === 'string' && entry.lineage.length > 0 && entry.lineage.length <= 64)
    && (entry.guardianPid === undefined || Number.isSafeInteger(entry.guardianPid) && entry.guardianPid > 0)
    && Number.isFinite(Date.parse(entry.until)) && Number.isFinite(Date.parse(entry.since));
}

/** A fence must still identify the current, unexpired holder under the current coordinator. */
export function assertLandingLease(board, fence, { shared = false } = {}) {
  requireConfirmedLanding(board);
  const holder = (shared ? sharedLandingLeaseState(board) : landingLeaseState(board)).holder;
  const lineage = coordinatorHolder(board)?.lineage ?? null;
  const heartbeat = !shared && localLandingEntry(board, holder);
  const legacyShared = shared && (board.executionEngineVersion ?? ENGINE_VERSION) < LANDING_LOCAL_LEASE_ENGINE;
  const deadline = heartbeat?.until ?? holder?.until;
  if (!holder || holder.token !== fence?.token || holder.generation !== fence?.generation || holder.branch !== fence?.branch
    || ((holder.lineage === null || heartbeat || legacyShared) && Date.parse(deadline) <= board.clock.now().getTime()) || holder.lineage !== lineage) {
    throw new Refused('LAND_LEASE_LOST', 'this command no longer holds the board landing lease; stop its external work, inspect pullboard resume and adopt only after the holder finishes');
  }
  return holder;
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
    const state = sharedLandingLeaseState(board);
    const modern = (board.executionEngineVersion ?? ENGINE_VERSION) >= LANDING_LOCAL_LEASE_ENGINE;
    const transition = value => JSON.stringify([value.generation, value.holder?.token ?? null, value.line.map(entry => entry.token)]);
    const previousTransition = transition(state);
    const before = JSON.stringify(state);
    const at = board.clock.now();
    if (action === 'release') {
      if (state.holder?.token === token && state.holder.generation === generation) state.holder = null;
      state.line = state.line.filter(entry => entry.token !== token);
    } else if (action === 'renew' || action === 'bind') {
      const holder = assertLandingLease(board, { token, branch, generation }, { shared: true });
      if (action === 'bind' && (!Number.isSafeInteger(guardianPid) || guardianPid < 1 || holder.guardianPid && holder.guardianPid !== guardianPid)) {
        throw new Refused('LAND_LEASE_REQUEST', 'this landing already names its owned guardian; start a new pullboard land command');
      }
      state.holder = { ...holder, ...(action === 'bind' ? { guardianPid } : {}), until: new Date(at.getTime() + LANDING_LEASE_MS).toISOString() };
    } else {
      requireConfirmedLanding(board);
      const lineage = coordinatorHolder(board)?.lineage ?? null;
      const expired = entry => modern && entry.lineage !== null
        ? entry.lineage !== lineage : Date.parse(entry.until) <= at.getTime();
      if (state.holder && expired(state.holder)) state.holder = null;
      state.line = state.line.filter(entry => !expired(entry));
      const old = state.holder?.token === token ? state.holder : state.line.find(entry => entry.token === token);
      const holder = coordinatorHolder(board);
      const entry = { token, branch, pid, label: `${holder?.label ?? 'coordinator'} landing ${token.slice(0, 8)}`,
        lineage: holder?.lineage ?? null, ...(modern ? { machine: holder?.machine ?? null } : {}), ...(old?.guardianPid ? { guardianPid: old.guardianPid } : {}),
        since: old?.since ?? at.toISOString(), until: new Date(at.getTime() + LANDING_LEASE_MS).toISOString() };
      if (!validEntry(entry)) throw new Refused('LAND_LEASE_REQUEST', 'a landing request needs its trunk and process identity; run pullboard land');
      if (old && (old.branch !== branch || old.pid !== pid || old.lineage !== entry.lineage)) {
        throw new Refused('LAND_LEASE_REQUEST', 'this landing identity already belongs to another invocation; start a new pullboard land command');
      }
      if (state.holder?.token === token) state.holder = { ...entry, generation: state.holder.generation };
      else if (old) state.line = state.line.map(queued => queued.token === token ? entry : queued);
      else state.line.push(entry);
      if (!state.holder && state.line.length) {
        state.generation += 1;
        state.holder = { ...state.line.shift(), generation: state.generation };
      }
    }
    if (JSON.stringify(state) !== before) save(board, state, action, token, !modern || transition(state) !== previousTransition, action === 'release' && typeof reason === 'string' ? reason.slice(0, 120) : null,
      action === 'request' ? backoffMs ?? undefined : undefined);
    return { holder: state.holder, position: state.line.findIndex(entry => entry.token === token) + 1,
      acquired: state.holder?.token === token, generation: state.holder?.token === token ? state.holder.generation : null };
  });
}
