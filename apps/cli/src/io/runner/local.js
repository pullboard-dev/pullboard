/**
 * The local runner, started from the board host: a pull submit, or a pulled landing, makes sure one
 * `pullboard runner local` process runs on this machine. It serves the board API on loopback and pulls jobs from it
 * with runner serve, the same pull path any runner takes, so adding runners later only adds capacity [P7].
 *
 * Why loopback: macOS keeps background services off the local network, never off 127.0.0.1, so the local runner
 * needs no permission and no address anyone else can reach.
 *
 * This module stays light: submit imports it, and only the runner process loads the API (local/serve.js).
 */
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { localRunnerEnabled } from '../../../../../packages/config/index.js';
import { addLocalBoard } from '../../../../../packages/drive/index.js';
import { localBoards } from '../../../../../packages/drive/index.js';
import { localRunnerStarting } from '../../../../../packages/drive/index.js';
import { localRunnerState } from '../../../../../packages/drive/index.js';
import { startLocalRunner as startProcess } from '../../../../../packages/drive/index.js';
import { wakeLocalRunner } from '../../../../../packages/drive/index.js';
import { machineHome } from '../../../../../packages/resources/index.js';

export { BOARD_HOST } from '../../../../../packages/drive/index.js';
const CLI = fileURLToPath(new URL('../../../pullboard.js', import.meta.url));
/** What the local runner keeps from the starting command's environment: where machine and account state live. */
const KEPT = new Set(['PULLBOARD_MACHINE_HOME', 'PULLBOARD_ACCOUNT_HOME', 'PULLBOARD_HOME', 'PULLBOARD_TEST_RUNNER_PID', 'PULLBOARD_FIXTURE_BOARD']);

/** The machine's local runner folder: its boards, state, lock, log and caches. */
export function localRunnerFolder() {
  return join(machineHome(), 'local-runner');
}

/** The PULLBOARD_HOME this command runs under, or null: the local runner's lock, state and starting marker are keyed to it [P7,C7]. */
export function localRunnerHome() {
  return environmentAdapter().get('PULLBOARD_HOME') || null;
}

/** The environment the local runner starts with: no seat's identity, only where this machine keeps its state. */
export function runnerEnv(env) {
  const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('PULLBOARD_') || KEPT.has(key)));
  delete kept.NODE_TEST_CONTEXT;
  return kept;
}

/**
 * Start `pullboard runner local` in the board's checkout, with its output in the folder's log; its pid, or null when
 * it did not start. The process itself makes sure it is the only one on this machine.
 * @param {string} root
 * @returns {Promise<number | null>}
 */
export function startLocalRunner(root, { env = environmentAdapter().all() } = {}) {
  return startProcess(localRunnerFolder(), [CLI, 'runner', 'local'], { cwd: root, env: runnerEnv(env), home: localRunnerHome() });
}

/**
 * Tell a live local runner a job was just offered, when runners.localWake is on: it claims at once instead of finishing
 * its idle wait. Off, or with no live runner, nothing happens.
 * Why here: the offering commands already call ensureLocalRunner once their offer is committed [C7,#10409].
 *
 * @returns {boolean} Whether the runner was woken.
 */
export function wakeRunnerForOffer() {
  return loadMachineSettings()['runners.localWake'] === true && wakeLocalRunner(localRunnerFolder());
}

/**
 * Make sure this machine's local runner serves the board at `root`: on a board with no registered runners the first
 * pull submit starts it, and every later submit or landing starts it again if it died. A board the local runner
 * already serves keeps it when runners are registered later, so they only add capacity [P7].
 *
 * @param {string} root - The board host's checkout.
 * @param {{ start?: (root: string) => Promise<number | null> }} [ports]
 * @returns {Promise<{ running: boolean, started: boolean, pid: number | null, reason: string | null }>}
 */
export async function ensureLocalRunner(root, { start = startLocalRunner } = {}) {
  if (!localRunnerEnabled()) return { running: false, started: false, pid: null, reason: 'gate.localRunner is off' };
  const folder = localRunnerFolder(), board = resolve(root);
  if (!localBoards(folder).includes(board)) {
    if ((loadMachineSettings().runners ?? []).length) return { running: false, started: false, pid: null, reason: 'runners are registered' };
    addLocalBoard(folder, board);
  }
  const home = localRunnerHome(), state = localRunnerState(folder, Date.now(), home);
  if (state) { wakeRunnerForOffer(); return { running: true, started: false, pid: state.pid, reason: null }; }
  // A runner an earlier command started moments ago is still loading: it serves this board once up, so start no second one [P7,C7,#10709].
  const starting = localRunnerStarting(folder, Date.now(), home);
  if (starting !== null) return { running: true, started: false, pid: starting, reason: null };
  const pid = await start(board);
  return { running: pid !== null, started: pid !== null, pid, reason: pid === null ? 'the local runner did not start' : null };
}

/**
 * Whether any runner can take a job now: a registered runner, or this machine's local runner alive in its folder.
 * Why: a baseline or gate job with no live runner waits forever, and the reads must say so instead of "running" [C7,#6559].
 *
 * @returns {boolean}
 */
export function anyRunnerLive() {
  return (loadMachineSettings().runners ?? []).length > 0 || localRunnerState(localRunnerFolder(), Date.now(), localRunnerHome()) !== null;
}
