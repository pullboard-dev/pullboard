import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive } from '../../../../../packages/drive/index.js';

// Budget: a stopped local runner hands back its job and exits within 10 s; one still alive then is killed outright.
const STOP_MS = 10_000;
// Budget: a state heartbeat older than 2 min names a pid the runner no longer holds, which may now be another process.
const FRESH_MS = 120_000;

/** The live local runner a fixture machine home started, or null when none runs or its heartbeat is stale. */
function liveRunnerPid(machineHome) {
  let state = null;
  try { state = JSON.parse(readFileSync(join(machineHome, 'local-runner', 'state.json'), 'utf8')); } catch { return null; }
  const pid = Number(state?.pid);
  return processAlive(pid) && Date.now() - Number(state.heartbeatAt) < FRESH_MS ? pid : null;
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
  while (pids.some(processAlive) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  for (const pid of pids) if (processAlive(pid)) signal(pid, 'SIGKILL');
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
