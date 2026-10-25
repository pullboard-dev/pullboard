/** Atomic corrections carry the frozen bar in the same ordered move [V2,H16]. */
import { createHash } from 'node:crypto';
import { AUTOMATIC_DISPATCH_ENGINE } from './automatic-dispatch-engine.js';
import { ENGINE_VERSION } from './machine.js';
import { Refused } from './refused.js';

/** Validate a deterministic correction before the enclosing edit changes any shared state. */
export function correctedBar(board, item, next, { correction, freeze }) {
  if (!correction) return null; // Historical edits retain their original pending/refreeze protocol.
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < AUTOMATIC_DISPATCH_ENGINE) {
    throw new Refused('ENGINE_VERSION', `atomic corrections require engine ${AUTOMATIC_DISPATCH_ENGINE}; upgrade Pullboard`);
  }
  if (typeof freeze !== 'function') throw new Refused('RELAY_MOVE', 'send the correction with its frozen bar using the current Pullboard CLI');
  const frozen = freeze({ ...item, ...next });
  if (!frozen || typeof frozen.text !== 'string' || typeof frozen.digest !== 'string'
    || createHash('sha256').update(frozen.text).digest('hex') !== frozen.digest) {
    throw new Refused('RELAY_MOVE', 'the corrected frozen bar is invalid; retry the edit with the current Pullboard CLI');
  }
  let value;
  try { value = JSON.parse(frozen.text); }
  catch { throw new Refused('RELAY_MOVE', 'the corrected frozen bar must be JSON; retry the edit'); }
  if (value.criterion !== next.item_criterion || (value.sourceCheck ?? value.check) !== next.item_check) {
    throw new Refused('RELAY_MOVE', 'the frozen correction must match the edited criterion and check; retry the edit');
  }
  return frozen;
}
