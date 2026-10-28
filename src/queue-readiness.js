/** Shared read-only queue blockers keep routing capacity and the queue on one policy [N2,B24]. */
import { foreignBlockers } from './cross-repo-dependencies.js';
import {
  localDependencyIds,
  dependencyLabel,
} from './item-dependencies.js';
import { itemFileCollisions } from './item-files.js';
import {
  itemById,
  laneHold,
  laneHolds,
  listItems,
} from './board-query.js';

/**
 * What an item waits on before an agent can take it: dependencies, file collisions and holds.
 *
 * @param {any} board
 * @param {any} item
 * @param {any[]} inFlight
 * @returns {string[]}
 */
export function itemWaits(board, item, inFlight) {
  return waitsWithLane(board, item, inFlight, laneHold(board, item.item_lane));
}

/** Apply the same blockers with a lane hold from the current read projection. */
function waitsWithLane(board, item, inFlight, lane) {
  const after = localDependencyIds(item)
    .map((id) => itemById(board, id))
    .filter((before) => before && before.item_status !== 'verified')
    .map((before) => `#${before.item_id} (${before.item_status})`);
  const collisions = itemFileCollisions(item, inFlight);
  return [...after, ...foreignBlockers(board, item).map(ref => `${dependencyLabel(ref)} (${ref.status} on its own board)`), ...collisions, ...(item.item_hold_reason ? [`held: ${item.item_hold_reason}`] : []), ...(lane ? [`${item.item_lane} lane held: ${lane.hold_reason}`] : [])];
}

/** Read ready open items through the queue's exact dependency, collision and hold checks. */
export function readyItems(board) {
  const inFlight = listItems(board, { all: true });
  const holds = new Map(laneHolds(board).map(hold => [hold.hold_lane, hold]));
  return inFlight.filter(item => item.item_status === 'open'
    && !waitsWithLane(board, item, inFlight, holds.get(item.item_lane) ?? null).length);
}
