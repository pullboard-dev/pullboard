/** The gate queue's machine settings, read from the file the caller names [O5]. */
import { environmentAdapter } from '../../../env/index.js';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { Refused } from '../../../kernel/light.js';
import { LINE_SETTING_DEFINITIONS } from '../logic/definitions.js';
import { validateKnownLineSetting } from '../logic/definitions.js';
import { gateQueueSettings } from '../logic/settings.js';
import { parseMachineSettings } from '../logic/settings.js';

/**
 * The test classifier override this process inherited, or null when it inherited none. A run started
 * on a runner carries the classification its controller used, so the runner never reclassifies from its
 * own machine settings (#1043).
 *
 * @returns {boolean|null}
 */
export function carriedBrowserByLaunch() {
  const carried = environmentAdapter().get('PULLBOARD_TEST_BROWSER_BY_LAUNCH');
  return carried === '1' ? true : carried === '0' ? false : null;
}

/**
 * Read the machine settings file as a plain object, or null when there is none. The caller names the file
 * (machineSettingsFile() in the resources cell's machine-home.js), so the queue cell never reaches up into config.
 *
 * @param {string} file - The machine settings file the caller resolved.
 * @returns {object|null}
 */
export function readMachineSettingsFile(file) {
  return parseMachineSettings(existsSync(file) ? readFileSync(file, 'utf8') : null, file);
}

/**
 * The gate pool's admission order, read from the settings file the caller supplies, the port that keeps the machine home in the config cell.
 *
 * @param {string} file - The machine settings file the caller resolved.
 * @returns {{ reviewsFirst: boolean, currentReleaseFirst: boolean, agingMinutes: number }}
 */
export function readGateQueueSettings(file) {
  return gateQueueSettings(readMachineSettingsFile(file), file);
}

/** Refuse unknown controls and out-of-range values without changing any live queue behavior. */
export function validateLineSetting(key, value) {
  if (!Object.hasOwn(LINE_SETTING_DEFINITIONS, key)) throw new Refused('LINE_SETTING_UNKNOWN', 'choose a known board line setting from pullboard settings line');
  validateKnownLineSetting(key, value);
}
