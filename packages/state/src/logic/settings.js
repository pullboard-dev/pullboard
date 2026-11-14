/** Read validated board line policy without loading the mutation engine [R1,R2,H16]. */
import { LINE_SETTING_DEFINITIONS } from '../../../queue/light.js';
import { validateKnownLineSetting } from '../../../queue/light.js';
import { Refused } from '../../../kernel/browser.js';

const PREFIX = 'line_setting:';

/** Read the latest recorded values, with every absent control explicitly off. */
export function lineSettings(board) {
  const values = Object.fromEntries(Object.keys(LINE_SETTING_DEFINITIONS).map(key => [key, false]));
  for (const row of board.db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key GLOB 'line_setting:*'").all()) {
    const key = row.meta_key.slice(PREFIX.length);
    if (!Object.hasOwn(values, key)) continue; // A future engine may have a control this reader does not know.
    let value;
    try { value = JSON.parse(row.meta_value); }
    catch { throw new Refused('LINE_SETTING_RANGE', 'a stored line setting is malformed; restore its recorded board value before changing policy'); }
    validateKnownLineSetting(key, value);
    values[key] = value;
  }
  return values;
}

/**
 * The instant a target the coordinator typed names, read in this machine's time zone, as UTC ISO
 * text, or `none` unchanged. The move is prepared with this value, so the ordered envelope never
 * carries a local time that another replica would read in its own zone.
 *
 * @param {unknown} target
 * @returns {unknown}
 */
export function canonicalMilestoneTarget(target) {
  if (target === 'none' || typeof target !== 'string' || !/\d/.test(target)) return target;
  const at = Date.parse(target.trim());
  return Number.isFinite(at) ? new Date(at).toISOString() : target;
}

