/** One on/off runner setting read from the machine settings file, for a serve that holds no CLI [C7,#9024,#9025]. */
import { readFileSync } from 'node:fs';

/**
 * Whether a machine setting under the `runners.` group is on: exactly true in the settings file, false for a missing
 * or unreadable file, a missing key or any other value.
 * Why flat: `runners` in settings.json is the list of registered runners, so a field named runners.<name> is a top-level
 * key spelled with its dot. Why here: a runner service imports only this file and the repo files it needs, never the config cell.
 *
 * @param {string} file - The machine settings file.
 * @param {string} key - The setting, such as runners.fetchFailFast.
 * @returns {boolean}
 */
export function runnerSettingOn(file, key) {
  try { return JSON.parse(readFileSync(file, 'utf8'))?.[key] === true; } catch { return false; }
}
