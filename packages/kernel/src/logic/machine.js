import { tmpdir } from 'node:os';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';

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
