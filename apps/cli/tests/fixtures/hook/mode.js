/** Whether a fixture's machine home turns on test.inProcessHooks, read where the fixture wrote it [C7,#9214]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read test.inProcessHooks from the machine settings file under env.PULLBOARD_MACHINE_HOME.
 * Why: the setting is a machine setting, so a fixture reads it from its own machine home, never the real one; a missing home, file or key, or any value but true, reads as off.
 *
 * @param {Record<string, string | undefined>} env - A fixture box's environment.
 * @returns {boolean} True only when the file holds test.inProcessHooks exactly true.
 */
export function inProcessHooksOn(env) {
  const home = env?.PULLBOARD_MACHINE_HOME;
  if (!home) return false;
  try {
    return JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))?.test?.inProcessHooks === true;
  } catch { return false; }
}
