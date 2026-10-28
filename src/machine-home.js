/** Resolve the per-account directory for machine-wide Pullboard state. */
import { userInfo } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { Refused } from './refused.js';

/**
 * Use the OS account home unless a caller explicitly selects a private machine pool. A test run substitutes its own
 * account home (PULLBOARD_ACCOUNT_HOME, src/test-isolation.js) so a test never reads the machine it runs on.
 */
export function machineHome() {
  const override = process.env.PULLBOARD_MACHINE_HOME;
  if (override) return resolve(override);
  return join(resolve(process.env.PULLBOARD_ACCOUNT_HOME || userInfo().homedir), '.pullboard');
}

/** Resolve the separate machine settings file; lower cells receive it from their caller rather than importing it. */
export function machineSettingsFile() {
  return join(machineHome(), 'settings.json');
}

/** Name inaccessible machine storage without disguising corruption or other database failures. */
export function withMachineHomeWrite(directory, work) {
  try { return work(); }
  catch (error) {
    const sqliteCode = error.code === 'ERR_SQLITE_ERROR' ? error.errcode & 0xff : null;
    if (['EACCES', 'EPERM', 'EROFS', 'SQLITE_CANTOPEN', 'SQLITE_READONLY'].includes(error.code)
        || sqliteCode === 14 || sqliteCode === 8) {
      throw new Refused('MACHINE_HOME_NOT_WRITABLE',
        `Cannot write machine home "${directory}". Give the agent write access to that directory (the access pullboard init grants), or run the command outside the sandbox.`);
    }
    throw error;
  }
}
