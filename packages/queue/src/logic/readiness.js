/** Shared read-only queue blockers keep routing capacity and the queue on one policy [N2,B24]. */
/**
 * What an item waits on before an agent can take it: dependencies, file collisions and holds.
 *
 * @param {any} board
 * @param {any} item
 * @param {any[]} inFlight
 * @returns {string[]}
 */
export function itemWaits(board, item, inFlight, foreignBlockers, reads = board.nativePorts) {
  return waitsWithLane(board, item, inFlight, reads.laneHold(board, item.item_lane), foreignBlockers, reads);
}

/** Apply the same blockers with a lane hold from the current read projection. */
function waitsWithLane(board, item, inFlight, lane, foreignBlockers, reads) {
  const after = reads.localDependencyIds(item)
    .map((id) => reads.itemById(board, id))
    .filter((before) => before && before.item_status !== 'verified')
    .map((before) => `#${before.item_id} (${before.item_status})`);
  const rivals = withoutLaterSubmissions(board, item, inFlight);
  const collisions = reads.itemCollisionPlan?.(board, item, rivals).blockers ?? reads.itemFileCollisions(item, rivals);
  return [...after, ...foreignBlockers(board, item).map(ref => `${reads.dependencyLabel(ref)} (${ref.status} on its own board)`), ...collisions, ...(item.item_hold_reason ? [`held: ${item.item_hold_reason}`] : []), ...(lane ? [`${item.item_lane} lane held: ${lane.hold_reason}`] : [])];
}

/**
 * The in-flight list a submitted item collides against: submitted items that came after it are left out, so of two
 * submitted items sharing a file only the later one waits, on the earlier, and never both on each other. Why: a queue
 * showed two submitted items waiting on each other with reviewers idle. Open and claimed items are unchanged.
 */
function withoutLaterSubmissions(board, item, inFlight) {
  if (item.item_status !== 'submitted') return inFlight;
  const order = new Map(board.db.prepare("SELECT item_id, MAX(event_id) AS at FROM event WHERE event_kind = 'submit' GROUP BY item_id").all()
    .map(row => [row.item_id, row.at]));
  const mine = order.get(item.item_id) ?? 0;
  return inFlight.filter(other => other.item_status !== 'submitted' || other.item_id === item.item_id || (order.get(other.item_id) ?? 0) <= mine);
}

/** Read ready open items through the queue's exact dependency, collision and hold checks. */
export function readyItems(board, foreignBlockers, reads = board.nativePorts) {
  const inFlight = reads.listItems(board, { all: true });
  const holds = new Map(reads.laneHolds(board).map(hold => [hold.hold_lane, hold]));
  return inFlight.filter(item => item.item_status === 'open'
    && !waitsWithLane(board, item, inFlight, holds.get(item.item_lane) ?? null, foreignBlockers, reads).length);
}
