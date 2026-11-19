import { Refused } from '../../../kernel/index.js';
import { ENGINE_VERSION } from '../../../state/index.js';
import { RESERVATION_ENGINE } from '../../../state/light.js';

/**
 * Record who an item is reserved for: a structured holder (a seat or block name), the actor that set it and the board's
 * own clock reading. A second reservation replaces the first. Nothing reads it yet [C7,#9181]. Why the instant is the
 * board's clock: every replica replays the same value.
 */
export function applyItemReservation(board, id, { agentId, holder }, dependencies) {
  const { coordinatorOnly, atomic, getItem, setItem, now, logEvent } = dependencies;
  coordinatorOnly(agentId, 'reserves an item');
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < RESERVATION_ENGINE) {
    throw new Refused('ENGINE_VERSION', 'item reservations require replay-aware writers; upgrade every linked device');
  }
  const named = String(holder ?? '').trim();
  if (!named) throw new Refused('USAGE', `a reservation names its holder: pullboard route ${id} --to <seat or block>`);
  return atomic(board, () => {
    const item = getItem(board, id);
    if (!['open', 'claimed'].includes(item.item_status) || item.item_merged_commit) {
      throw new Refused('ITEM_NOT_OPEN', `item #${id} is ${item.item_status}; only open or claimed items can be reserved`);
    }
    const at = now(board);
    setItem(board, id, { item_reservation_holder: named, item_reservation_by: agentId, item_reservation_at: at });
    logEvent(board, agentId, 'reserve_item', id, { holder: named });
    return { holder: named, by: agentId, at };
  });
}
