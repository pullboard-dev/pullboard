/** Native prerequisite membership and meaningful work are shared by capture and replay validation [C7,B4,H16]. */

/** Find only open or claimed local dependents, matching complete comma-delimited prerequisite ids. */
export function dependencyWaiters(board, id) {
  return board.db.prepare("SELECT item_id,item_owner,item_lane FROM item WHERE item_status IN ('open','claimed') AND instr(',' || item_after || ',', ',' || ? || ',')>0 ORDER BY item_id").all(String(id));
}

/** Measure the current claim's commit, recorded test or fact; renewals and heartbeats cannot manufacture progress. */
export function dependencyWorkAt(board, item, commitAt, observedAt) {
  const boundary = board.db.prepare("SELECT COALESCE(MAX(event_id),0) AS id FROM event WHERE item_id=? AND event_kind IN ('release','submit','reopen','withdraw','merged','accept','reject','refreeze')").get(item.item_id).id;
  const claim = board.db.prepare("SELECT event_at FROM event WHERE item_id=? AND event_by=? AND event_kind='claim' AND event_id>? ORDER BY event_id LIMIT 1").get(item.item_id, item.item_owner, boundary);
  const progress = board.db.prepare("SELECT event_at FROM event WHERE item_id=? AND event_by=? AND event_kind IN ('proof-run','fact') AND event_id>? ORDER BY event_id DESC LIMIT 1").get(item.item_id, item.item_owner, boundary);
  if (!commitAt || !claim) return null;
  const values = [commitAt, claim.event_at, ...(progress ? [progress.event_at] : [])];
  const instants = values.map(value => Date.parse(value));
  if (instants.some((instant, index) => !Number.isFinite(instant) || instant > observedAt || new Date(instant).toISOString() !== values[index])) return null;
  return new Date(Math.max(...instants)).toISOString();
}
