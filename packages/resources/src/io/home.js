/** Resolve the per-account directory for machine-wide Pullboard state. */
import { join } from 'node:path';
import { processMachineHome } from '../../../kernel/light.js';
import { Refused } from '../../../kernel/light.js';

/** This process's machine home; the rule lives in kernel so the board's logs reach it without this cell's door [C7,#6483]. */
export function machineHome() {
  return processMachineHome();
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
