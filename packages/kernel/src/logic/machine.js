import { existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { Refused } from './refused.js';

/** The machine home from explicit inputs; one rule below the parse cache, gate and runners [C7]. */
export function machineHome({ override, accountHome, osHome }) {
  return override ? resolve(override) : join(resolve(accountHome || osHome), '.pullboard');
}

/**
 * This process's per-account directory for machine-wide Pullboard state, read from its environment.
 * Use the OS account home unless a caller explicitly selects a private machine pool. A test run substitutes its own
 * account home (PULLBOARD_ACCOUNT_HOME, packages/gate/src/io/test/isolation.js) so a test never reads the machine it runs on. A process
 * inside a test run that has lost both, as a fixture building its own environment can, still gets a private pool under
 * the run's temporary directory: a fixture must never queue for the real machine's runners or browser slots [C7].
 * Why here: the board's write and hold logs need it on every cold read, and the resources door costs them ~55 modules [#6483].
 */
export function processMachineHome() {
  const { PULLBOARD_MACHINE_HOME: override, PULLBOARD_ACCOUNT_HOME: accountHome, PULLBOARD_TEST_RUNNER_PID: runner } = process.env;
  if (!override && !accountHome && runner) return join(tmpdir(), `pullboard-test-machine-${runner}`);
  // The OS account is read only without an override: a sandbox denying process-info traps the lookup (exit 133).
  return machineHome({ override, accountHome, osHome: override || accountHome ? undefined : userInfo().homedir });
}

/**
 * The scratch root a low cell uses. The CLI resolves the `scratch` machine setting into PULLBOARD_SCRATCH once per command,
 * so a cell that cannot import config still lands under the setting.
 * Why a second reader: config sits above these cells in the order, so they cannot import its scratchRoot [C7].
 *
 * @param {Record<string, string | undefined>} [env] - Environment, defaulting to process.env.
 * @returns {string} The realpath of the named root, or os.tmpdir() when none is named.
 */
export function scratchBase(env = process.env) {
  const named = env.PULLBOARD_SCRATCH;
  if (!named) return tmpdir();
  if (!isAbsolute(named) || !existsSync(named) || !statSync(named).isDirectory()) {
    throw new Refused('BAD_SCRATCH_ROOT', `scratch ${named} is not an existing absolute folder; create it, or run pullboard settings scratch <absolute folder> to name another, or remove it to use ${tmpdir()}`);
  }
  return realpathSync(named);
}
