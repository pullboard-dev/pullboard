/** Own the worker's subprocess groups, transport custody and drain, so a lease is released only when all are gone [C7]. */
import { beginCleanup } from './cleanup.js';
import { spawn } from 'node:child_process';

/**
 * Start a subprocess in a private process group so this worker can drain only its own descendants.
 * bindLater defers the leader's census binding to the next census, for short runner-owned commands.
 */
export function spawnOwned(S, command, args, { bindLater = false, ...options } = {}) {
  assertTransportLive(S);
  const child = spawn(command, args, { ...options, detached: true });
  let settle;
  const closed = new Promise(resolveClose => { settle = resolveClose; });
  const identity = S.activeDescendantTracker?.registerRoot(child.pid, { bindNow: !bindLater });
  const record = { ...identity, child, pid: child.pid, command, closed, drainPromise: null };
  S.ownedChildren.set(child, record);
  child.once('error', error => settle({ error }));
  child.once('close', (code, signal) => settle({ code, signal }));
  return record;
}

/** Stop and fully drain one owned process group before its gate lease can be released. */
export function drainOwned(S, record, terminate = false, tracker = S.activeDescendantTracker) {
  if (!record) return Promise.resolve();
  record.drainPromise ??= (async () => {
    if (terminate) await stopOwnedGroup(record.pid, record.closed, tracker);
    else {
      await record.closed;
      // An emptied group has nothing left to stop; only a group with members needs a census-proven signal.
      if (groupHasMembers(record.pid)) await stopOwnedGroup(record.pid, record.closed, tracker);
    }
    S.ownedChildren.delete(record.child);
  })();
  return record.drainPromise;
}

/** Install disconnect custody before receiving the pack or starting any setup subprocess. */
export function installSignalCustody(S) {
  if (S.signalCustodyInstalled) return;
  S.signalCustodyInstalled = true;
  const disconnected = () => {
    if (S.transportLost) return;
    S.transportLost = true;
    S.markTransportGone();
    beginCleanup(S);
    S.rejectPendingFrame?.(new Error('runner transport was lost'));
    clearInterval(S.heartbeatTimer);
    const active = [...S.ownedChildren.values()];
    S.transportDrain = (async () => {
      await S.activeDescendantTracker?.stopDescendants();
      await Promise.all(active.map(record => drainOwned(S, record, true)));
      await S.activeDescendantTracker?.verifyAfterGroups();
    })();
    S.transportDrain.catch(() => {});
  };
  S.transportDrop = disconnected;
  process.on('SIGHUP', disconnected);
  process.on('SIGTERM', disconnected);
  process.stdin.on('error', disconnected);
  process.stdout.on('error', disconnected);
  process.stderr.on('error', disconnected);
  let heartbeatPending = false;
  S.heartbeatTimer = setInterval(() => {
    if (S.transportLost || heartbeatPending) return;
    heartbeatPending = true;
    process.stderr.write(`PULLBOARD_RUNNER_HEARTBEAT ${S.workerId}\n`, error => {
      heartbeatPending = false;
      if (error) disconnected();
    });
  }, 5_000);
  S.heartbeatTimer.unref();
}

/** Stop queue/setup work promptly after the controller's transport disappears. */
export function assertTransportLive(S) {
  if (S.transportLost) throw new Error('runner transport was lost');
}

/**
 * Run one startup step, retrying with backoff while the machine resource database is locked.
 * Why: on 8 Nov a locked resources.sqlite during the worker's startup bridge ended the worker before READY, the controller
 * read that as WORKER_UNRESPONSIVE and quarantined the runner, and 3 of 7 runners went out (#3086). A lock always frees.
 *
 * @param {object} S - Worker state; the transport must stay live between tries.
 * @param {() => Promise<any>} work - The startup step.
 * @param {{ wait?: (ms: number) => Promise<void>, tries?: number, pauseMs?: number }} [options]
 */
export async function retrySlotLocked(S, work, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), tries = 8, pauseMs = 2_000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await work(); }
    catch (error) {
      if (error?.code !== 'SLOT_DB_LOCKED' || attempt >= tries) throw error;
      assertTransportLive(S);
      await wait(Math.min(pauseMs * attempt, 10_000));
      assertTransportLive(S);
    }
  }
}

/** Wait for every owned group, terminating any still present after its leader exits. */
export async function drainAllOwned(S) {
  await Promise.all([...S.ownedChildren.values()].map(record => drainOwned(S, record, S.transportLost)));
  if (S.transportDrain) await S.transportDrain;
}

/** Ask the kernel whether any process is left in a group; anything but a definite no keeps the census path. */
function groupHasMembers(pgid) {
  if (!pgid) return false;
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** Stop only the detached command process group owned by this worker, then await its close event. */
async function stopOwnedGroup(pid, closed, tracker) {
  if (!pid) return;
  const signal = async type => {
    for (;;) {
      // Keep null (an ambiguous census, or EPERM) distinct from false, so it retries instead of passing as drained.
      const sent = tracker ? tracker.signalOwnedGroup(pid, type) : false;
      if (sent === true || sent === false) return sent;
      await new Promise(resolvePause => setTimeout(resolvePause, 250));
    }
  };
  if (await signal('SIGTERM') === false) { await closed; return; }
  // Give the whole owned group two seconds to handle TERM, even if its leader exits first.
  const graceUntil = Date.now() + 2_000;
  while (Date.now() < graceUntil) {
    const sent = await signal('SIGTERM');
    if (!sent) break;
    await new Promise(resolvePause => setTimeout(resolvePause, 25));
  }
  for (;;) {
    const sent = await signal('SIGKILL');
    if (!sent) break;
    await new Promise(resolvePause => setTimeout(resolvePause, 50));
  }
  await closed;
}
