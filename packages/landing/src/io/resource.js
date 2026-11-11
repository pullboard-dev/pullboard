/** Wait for board admission without occupying a machine test slot [Q1,Q2,Q3]. */
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import {
  assertLandingLease,
  landingLeaseState,
  renewLocalLanding,
} from '../../../store/index.js';
import { LANDING_LEASE_MS } from '../../../store/index.js';
import { Refused } from '../../../kernel/index.js';
import { startGuardian } from './worker.js';
import { LANDING_BACKOFF_MAX_MS } from '../logic/retry.js';
import { coordinatorHolder } from '../../../seats/index.js';
import { localLandingEntry } from '../../../store/index.js';
import { rememberLocalLanding } from '../../../store/index.js';
import { forgetLocalLanding } from '../../../store/index.js';

/** Asks why this process's landing-lease waits stop (a reason or null); set by a lander whose loaded code may be older than main's. */
let waitsStopped = null;

/**
 * Stop this process's landing-lease waits when `ask` returns a reason: a request waiting in line releases its place with
 * it and refuses LAND_CODE_STALE; a held lease is untouched. Null clears it. Why: a lander running code older than main never runs
 * the fixes main has landed, and waited behind a dead holder for 15 hours on 7 Nov (#3467).
 *
 * @param {(() => string | null) | null} ask - Returns why, short enough for the landing_lease event (120 characters), or null.
 */
export function stopLandingWaits(ask) {
  waitsStopped = typeof ask === 'function' ? ask : null;
}

/** True when a process id no longer exists on this machine; a permission error means it still runs. */
function processGone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

/**
 * Why a holder may be released now, or null. A dead local owner is released at once on an unlinked board. A holder
 * recorded on this machine with no process, no guardian and a heartbeat older than the lease (2 minutes) is released
 * on a linked board too: its local mark can be gone, and without this the queue stalled for hours (#3392). Never compare foreign PIDs.
 */
export function reclaimReason(holder, local, { now = Date.now(), machine = null } = {}) {
  if (!holder) return null;
  if (local && Date.parse(local.until) <= now) return 'heartbeat expired';
  const gone = processGone(holder.pid) && (!holder.guardianPid || processGone(holder.guardianPid));
  if (!gone) return null;
  if (holder.lineage === null || local) return 'holder process gone';
  const sameMachine = machine !== null && holder.machine === machine;
  return sameMachine && Date.parse(holder.until) <= now ? 'holder process gone and heartbeat older than the lease' : null;
}

/**
 * Run one renewal, retrying BOARD_BUSY with doubling backoff until the lease period ends; any other refusal, and the
 * last BOARD_BUSY, propagates. Why: a busy board is a momentary landing fault, and one refusal killed the worker (#3068).
 */
export async function renewWithBackoff(renew, { now = Date.now, pausing = pause, until = () => now() + LANDING_LEASE_MS, firstMs = 100, marginMs = 1000 } = {}) {
  for (let wait = firstMs; ; wait = Math.min(wait * 2, 2000)) {
    try { return renew(); }
    catch (error) {
      // Stop at the acknowledged lease deadline, re-read after every pause, so a busy board never outlives the lease.
      if (error?.code !== 'BOARD_BUSY' || now() + wait >= until() - marginMs) throw error;
      await pausing(wait);
      if (now() >= until() - marginMs) throw error;
    }
  }
}

/** Return a generation-bound lease whose renewal failures prevent later landing writes. */
export async function takeLandingResource({ board, write, branch, onWait, onLost, refresh = async () => {} }) {
  const token = randomUUID();
  const parameters = { agentId: 'coordinator', token, branch, pid: process.pid, localHeartbeat: true };
  // A scheduled wake that follows a back-off names it, so the lease request's event records why this landing started late [C7].
  const backoffMs = Number(process.env.PULLBOARD_LANDING_BACKOFF_MS);
  const backoff = Number.isSafeInteger(backoffMs) && backoffMs > 0 && backoffMs <= LANDING_BACKOFF_MAX_MS ? { backoffMs } : {};
  let generation = null;
  let timer;
  let watchdog;
  let deadline = 0;
  const deadlineListeners = new Set();
  let pending = Promise.resolve();
  let lost = null;
  let guardian = null;
  let stopWatching = null;
  /** Send only acknowledged deadlines to the independent guardian. */
  const confirmedUntil = until => {
    deadline = Date.parse(until);
    for (const listener of deadlineListeners) listener(deadline);
  };
  /** Serialize heartbeats and explicit checks, retaining a failure until the command stops. */
  const assertHeld = () => {
    const task = pending.then(async () => {
      if (lost) throw lost;
      try {
        const result = await renewWithBackoff(() => renewLocalLanding(board, { ...parameters, generation }), { until: () => deadline || Date.now() + LANDING_LEASE_MS });
        if (lost) throw lost;
        const holder = assertLandingLease(board, { token, branch, generation }); // A delayed recovered receipt is not a fresh grant.
        confirmedUntil(holder.until);
        return result;
      }
      catch (error) { lost = error; onLost?.(error); throw error; }
    });
    pending = task.catch(() => {});
    return task;
  };
  try {
    let queued = false;
    while (true) {
      if (queued) await refresh();
      const state = landingLeaseState(board);
      const holder = state.holder;
      const local = localLandingEntry(board, holder);
      const reason = reclaimReason(holder, local, { now: board.clock.now().getTime(), machine: coordinatorHolder(board)?.machine ?? null });
      if (reason) {
        await write('landingLeaseMove', [{ agentId: 'coordinator', action: 'release', token: holder.token, generation: holder.generation, reason }]);
      }
      let result;
      const current = landingLeaseState(board);
      const entry = current.line.find(value => value.token === token);
      if (queued && current.holder && entry && current.holder.lineage === (coordinatorHolder(board)?.lineage ?? null)) {
        if (current.holder.lineage === null) {
          // An unlinked board has one physical authority; refresh the existing ticket without a relay.
          const { landingLeaseMove } = await import('../../../store/index.js');
          result = landingLeaseMove(board, { ...parameters, action: 'request' });
        } else result = { holder: current.holder, position: current.line.indexOf(entry) + 1, acquired: false, generation: null };
        rememberLocalLanding(board, { ...entry, until: new Date(board.clock.now().getTime() + 30_000).toISOString() });
      } else {
        result = await write('landingLeaseMove', [{ ...parameters, action: 'request', ...backoff }]);
        const acknowledged = result.acquired ? result.holder : landingLeaseState(board).line.find(value => value.token === token);
        if (acknowledged) rememberLocalLanding(board, acknowledged);
        queued = !result.acquired;
      }
      if (result.acquired) { generation = result.generation; confirmedUntil(result.holder.until); break; }
      // Only a wait in line stops: the place is released below with the reason, so the queue names why it left (#3467).
      const stopped = waitsStopped?.();
      if (stopped) throw Object.assign(new Refused('LAND_CODE_STALE', `${stopped}; a fresh lander takes over`), { leaseReason: stopped });
      await onWait?.({ holders: result.holder ? [result.holder] : [], position: result.position });
      await pause(1000);
    }
    timer = setInterval(() => { void assertHeld().catch(() => {}); }, 5000);
    timer.unref();
    watchdog = setInterval(() => {
      if (!lost && Date.now() >= deadline - 1000) {
        lost = new Refused('LAND_LEASE_LOST', 'the landing lease could not renew before its deadline; inspect pullboard resume after its owned worker stops');
        onLost?.(lost);
      }
    }, 100);
    watchdog.unref();
    return { name: 'landing', scope: 'board', fence: { token, branch, generation }, assertHeld,
      /** Record the guardian before it starts physical work, so dead-parent recovery waits for its drain. */
      async bindWorker(guardianPid) {
        await assertHeld();
        if (lost) throw lost;
        await write('landingLeaseMove', [{ ...parameters, action: 'bind', generation, guardianPid }]);
        if (lost) throw lost;
        confirmedUntil(assertLandingLease(board, { token, branch, generation }).until);
      },
      /**
       * Start this landing's guardian before any gate runs and record it on the lease. Dead-command recovery waits for its
       * drain; a guardian that dies first stops the gate and ends the landing with LAND_WORKER, leaving its batch to adoption.
       */
      async guard(controller) {
        guardian = startGuardian({ boardFile: board.db.prepare('PRAGMA database_list').get()?.file || null, leaseToken: token, onDeath: () => { if (lost) return; try { assertLandingLease(board, { token, branch, generation }); } catch (error) { if (error?.code === 'LAND_LEASE_LOST') { lost = error; onLost?.(error); controller.abort(error); return; } } controller.abort(new Refused('LAND_WORKER', 'the landing guardian stopped; its gate was stopped and the batch stays for pullboard land --adopt')); } });
        stopWatching = this.watchDeadline(at => guardian?.deadline(at));
        await this.bindWorker(guardian.pid);
      },
      /** Keep the guardian's own deadline current even if this parent later stops responding. */
      watchDeadline(listener) { deadlineListeners.add(listener); listener(deadline); return () => deadlineListeners.delete(listener); },
      /** Check the current wall-time fence without adding an await before a physical action. */
      assertCurrent() { return assertLandingLease(board, { token, branch, generation }); },
      /** End renewals before releasing; a stale generation never clears its successor. */
      async release() {
        clearInterval(timer);
        clearInterval(watchdog);
        stopWatching?.();
        guardian?.end();
        await guardian?.settle();
        await pending;
        await write('landingLeaseMove', [{ ...parameters, action: 'release', generation }]);
        forgetLocalLanding(board, token);
      } };
  } catch (error) {
    clearInterval(timer);
    clearInterval(watchdog);
    try { await write('landingLeaseMove', [{ ...parameters, action: 'release', generation, ...(error?.leaseReason ? { reason: error.leaseReason } : {}) }]); }
    catch { /* Preserve the admission failure; the ordered lease expires without a false grant. */ }
    throw error;
  }
}
