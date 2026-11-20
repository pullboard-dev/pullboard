import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive } from '../../../../../packages/drive/index.js';

// Budget: a stopped local runner hands back its job and exits within 10 s; one still alive then is killed outright.
const STOP_MS = 10_000;
// Budget: a state heartbeat older than 2 min names a pid the runner no longer holds, which may now be another process.
const FRESH_MS = 120_000;

/**
 * Whether the process still runs: alive to a signal and not an exited child waiting to be reaped.
 * Why: a runner the in-process CLI started is a child of this test process; once it has exited it stays a zombie, which a
 * signal-zero still finds, until this event loop reaps it, and the loop is blocked while the stop waits. So each stop
 * waited its whole 10 s budget for a runner that had exited within 0.1 s [C7].
 */
function running(pid) {
  if (!processAlive(pid)) return false;
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return !String(state.stdout ?? '').trim().startsWith('Z');
}

/** The live local runner a fixture machine home started under any PULLBOARD_HOME, or null when none runs or its heartbeat is stale. */
function liveRunnerPid(machineHome) {
  const folder = join(machineHome, 'local-runner');
  let names = [];
  try { names = readdirSync(folder).filter(name => /^state(-[0-9a-f]{12})?\.json$/u.test(name)); } catch { return null; }
  for (const name of names) {
    let state = null;
    try { state = JSON.parse(readFileSync(join(folder, name), 'utf8')); } catch { continue; }
    const pid = Number(state?.pid);
    if (processAlive(pid) && Date.now() - Number(state.heartbeatAt) < FRESH_MS) return pid;
  }
  return null;
}

/**
 * Stop the loopback local runners of several fixture machine homes together, and wait until each has exited.
 * Why: a pull submit or landing starts `pullboard runner local` for the fixture's machine home, and launchd or a
 * detached spawn keeps it running after the test; it heartbeats into the sandbox, so removing the sandbox retried
 * ENOTEMPTY until the file limit, and the runner outlived the test file [P7,#6577]. Each runner takes seconds to
 * hand its job back, so stopping them one after another held a file with five sandboxes past the 30 s file-exit
 * timeout though every case passed; every runner is signalled first and one shared deadline covers the wait [C7].
 *
 * @param {string[]} machineHomes - The fixtures' PULLBOARD_MACHINE_HOME folders.
 * @returns {number} How many runners were running and have now stopped.
 */
export function stopFixtureLocalRunners(machineHomes) {
  const pids = machineHomes.map(liveRunnerPid).filter(pid => pid !== null);
  const signal = (pid, name) => { try { process.kill(pid, name); } catch { /* it has exited */ } };
  for (const pid of pids) signal(pid, 'SIGTERM');
  const deadline = Date.now() + STOP_MS;
  while (pids.some(running) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  for (const pid of pids) if (running(pid)) signal(pid, 'SIGKILL');
  return pids.length;
}

/**
 * Stop the loopback local runner a fixture machine home started, and wait until it has exited.
 *
 * @param {string} machineHome - The fixture's PULLBOARD_MACHINE_HOME.
 * @returns {boolean} true when a runner was running and has now stopped.
 */
export function stopFixtureLocalRunner(machineHome) {
  return stopFixtureLocalRunners([machineHome]) > 0;
}
