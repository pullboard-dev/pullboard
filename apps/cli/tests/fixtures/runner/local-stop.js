import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive } from '../../../../../packages/drive/index.js';

// Budget: a stopped local runner hands back its job and exits within 10 s; one still alive then is killed outright.
const STOP_MS = 10_000;
// Budget: a state heartbeat older than 2 min names a pid the runner no longer holds, which may now be another process.
const FRESH_MS = 120_000;

/**
 * Stop the loopback local runner a fixture machine home started, and wait until it has exited.
 * Why: a pull submit or landing starts `pullboard runner local` for the fixture's machine home, and launchd or a
 * detached spawn keeps it running after the test; it heartbeats into the sandbox, so removing the sandbox retried
 * ENOTEMPTY until the file limit, and the runner outlived the test file [P7,#6577].
 *
 * @param {string} machineHome - The fixture's PULLBOARD_MACHINE_HOME.
 * @returns {boolean} true when a runner was running and has now stopped.
 */
export function stopFixtureLocalRunner(machineHome) {
  let state = null;
  try { state = JSON.parse(readFileSync(join(machineHome, 'local-runner', 'state.json'), 'utf8')); } catch { return false; }
  const pid = Number(state?.pid);
  if (!processAlive(pid) || !(Date.now() - Number(state.heartbeatAt) < FRESH_MS)) return false;
  const signal = name => { try { process.kill(pid, name); } catch { /* it has exited */ } };
  signal('SIGTERM');
  const deadline = Date.now() + STOP_MS;
  while (processAlive(pid) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  if (processAlive(pid)) signal('SIGKILL');
  return true;
}
