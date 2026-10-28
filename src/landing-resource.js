/** Wait for board admission without occupying a machine test slot [Q1,Q2,Q3]. */
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import {
  assertLandingLease,
  landingLeaseState,
  renewLocalLanding,
} from './landing-lease.js';
import { Refused } from './refused.js';
import { coordinatorHolder } from './coordinator-hold.js';
import {
  localLandingEntry,
  rememberLocalLanding,
  forgetLocalLanding,
} from './board-landing-local-lease.js';

/** A dead local owner can be released immediately on an unlinked board; never compare foreign PIDs. */
function deadLocalOwner(holder, local) {
  if (!holder || holder.lineage !== null && !local) return false;
  try { process.kill(holder.pid, 0); return false; }
  catch (error) {
    if (error.code !== 'ESRCH') return false;
    if (holder.guardianPid) {
      try { process.kill(holder.guardianPid, 0); return false; }
      catch (guardianError) { return guardianError.code === 'ESRCH'; }
    }
    return true;
  }
}

/** Return a generation-bound lease whose renewal failures prevent later landing writes. */
export async function takeLandingResource({ board, write, branch, onWait, onLost, refresh = async () => {} }) {
  const token = randomUUID();
  const parameters = { agentId: 'coordinator', token, branch, pid: process.pid, localHeartbeat: true };
  let generation = null;
  let timer;
  let watchdog;
  let deadline = 0;
  const deadlineListeners = new Set();
  let pending = Promise.resolve();
  let lost = null;
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
        const result = renewLocalLanding(board, { ...parameters, generation });
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
      if (deadLocalOwner(holder, local) || local && Date.parse(local.until) <= board.clock.now().getTime()) {
        await write('landingLeaseMove', [{ agentId: 'coordinator', action: 'release', token: holder.token, generation: holder.generation }]);
      }
      let result;
      const current = landingLeaseState(board);
      const entry = current.line.find(value => value.token === token);
      if (queued && current.holder && entry && current.holder.lineage === (coordinatorHolder(board)?.lineage ?? null)) {
        if (current.holder.lineage === null) {
          // An unlinked board has one physical authority; refresh the existing ticket without a relay.
          const { landingLeaseMove } = await import('./landing-lease.js');
          result = landingLeaseMove(board, { ...parameters, action: 'request' });
        } else result = { holder: current.holder, position: current.line.indexOf(entry) + 1, acquired: false, generation: null };
        rememberLocalLanding(board, { ...entry, until: new Date(board.clock.now().getTime() + 30_000).toISOString() });
      } else {
        result = await write('landingLeaseMove', [{ ...parameters, action: 'request' }]);
        const acknowledged = result.acquired ? result.holder : landingLeaseState(board).line.find(value => value.token === token);
        if (acknowledged) rememberLocalLanding(board, acknowledged);
        queued = !result.acquired;
      }
      if (result.acquired) { generation = result.generation; confirmedUntil(result.holder.until); break; }
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
      /** Keep the guardian's own deadline current even if this parent later stops responding. */
      watchDeadline(listener) { deadlineListeners.add(listener); listener(deadline); return () => deadlineListeners.delete(listener); },
      /** Check the current wall-time fence without adding an await before a physical action. */
      assertCurrent() { return assertLandingLease(board, { token, branch, generation }); },
      /** End renewals before releasing; a stale generation never clears its successor. */
      async release() {
        clearInterval(timer);
        clearInterval(watchdog);
        await pending;
        await write('landingLeaseMove', [{ ...parameters, action: 'release', generation }]);
        forgetLocalLanding(board, token);
      } };
  } catch (error) {
    clearInterval(timer);
    clearInterval(watchdog);
    try { await write('landingLeaseMove', [{ ...parameters, action: 'release', generation }]); }
    catch { /* Preserve the admission failure; the ordered lease expires without a false grant. */ }
    throw error;
  }
}
