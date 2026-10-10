/** Resolve the per-account directory for machine-wide Pullboard state. */
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';

/** Use the OS account home unless a caller explicitly selects a private machine pool. */
export function machineHome() {
  const override = process.env.PULLBOARD_MACHINE_HOME;
  return override ? resolve(override) : join(userInfo().homedir, '.pullboard');
}
