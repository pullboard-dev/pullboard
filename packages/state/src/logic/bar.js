/** Atomic corrections carry the frozen bar in the same ordered move [V2,H16]. */
import { engineNumber } from './engine/number.js';
import { engineAtLeast } from './engine/minimum.js';
import { Refused } from '../../../kernel/browser.js';
const AUTOMATIC_DISPATCH_ENGINE = engineNumber('AUTOMATIC_DISPATCH_ENGINE');

/** Validate a deterministic correction before the enclosing edit changes any shared state. */
export function correctedBar(board, item, next, { correction, freeze, sha256 }) {
  if (!correction) return null; // Historical edits retain their original pending/refreeze protocol.
  if (!engineAtLeast(board, AUTOMATIC_DISPATCH_ENGINE)) {
    throw new Refused('ENGINE_VERSION', `atomic corrections require engine ${AUTOMATIC_DISPATCH_ENGINE}; upgrade Pullboard`);
  }
  if (typeof freeze !== 'function') throw new Refused('RELAY_MOVE', 'send the correction with its frozen bar using the current Pullboard CLI');
  // The digest is checked through the caller's hash port, so this pure reader loads no crypto module.
  if (typeof sha256 !== 'function') throw new TypeError('a corrected bar needs its explicit sha256 port');
  const frozen = freeze({ ...item, ...next });
  if (!frozen || typeof frozen.text !== 'string' || typeof frozen.digest !== 'string'
    || sha256(frozen.text) !== frozen.digest) {
    throw new Refused('RELAY_MOVE', 'the corrected frozen bar is invalid; retry the edit with the current Pullboard CLI');
  }
  let value;
  try { value = JSON.parse(frozen.text); }
  catch { throw new Refused('RELAY_MOVE', 'the corrected frozen bar must be JSON; retry the edit'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.criterion !== next.item_criterion
    || (value.sourceCheck ?? value.check ?? '') !== next.item_check
    || (value.checkTiming === true) !== (next.item_check_timing === true)) {
    throw new Refused('RELAY_MOVE', 'the frozen correction must match the edited criterion and check; retry the edit');
  }
  return frozen;
}
