/** Native prerequisite membership and meaningful work are shared by capture and replay validation [C7,B4,H16]. */

/** Find only open or claimed local dependents, matching complete comma-delimited prerequisite ids. */
export function dependencyWaiters(board, id) {
  return board.db.prepare("SELECT item_id,item_owner,item_lane FROM item WHERE item_status IN ('open','claimed') AND instr(',' || item_after || ',', ',' || ? || ',')>0 ORDER BY item_id").all(String(id));
}

/** Measure the current claim's commit, recorded test or fact; renewals and heartbeats cannot manufacture progress. */
export function dependencyWorkAt(board, item, commitAt, observedAt) {
  const boundary = board.db.prepare("SELECT COALESCE(MAX(event_id),0) AS id FROM event WHERE item_id=? AND event_kind IN ('release','submit','reopen','withdraw','merged','accept','reject','refreeze')").get(item.item_id).id;
  const claim = board.db.prepare("SELECT event_at FROM event WHERE item_id=? AND event_by=? AND event_kind='claim' AND event_id>? ORDER BY event_id LIMIT 1").get(item.item_id, item.item_owner, boundary);
  if (!commitAt || !claim) return null;
  // Native check/submit receipts are gate-run events with a null event.item_id; their proof binds the item and seat.
  // Use execution time, not a late recording time, and never let another seat's comparison renew this claim's work.
  const progress = board.db.prepare(`SELECT CASE WHEN event_kind='gate-run' THEN json_extract(event_detail,'$.run.at') ELSE event_at END AS activity_at
    FROM event WHERE event_by=? AND event_id>? AND (
      (item_id=? AND event_kind IN ('proof-run','fact')) OR
      (event_kind='gate-run' AND json_valid(event_detail) AND json_extract(event_detail,'$.run.version')=2
        AND length(json_extract(event_detail,'$.run.head')) IN (40,64) AND json_extract(event_detail,'$.run.head') NOT GLOB '*[^0-9a-f]*'
        AND length(json_extract(event_detail,'$.run.tree')) IN (40,64) AND json_extract(event_detail,'$.run.tree') NOT GLOB '*[^0-9a-f]*'
        AND json_extract(event_detail,'$.run.proof.item')=?
        AND json_extract(event_detail,'$.run.proof.seat')=? AND json_extract(event_detail,'$.run.kind') IN ('check','submit')
        AND json_extract(event_detail,'$.run.at')>=? AND json_extract(event_detail,'$.run.at')<=?))
    ORDER BY activity_at DESC LIMIT 1`).get(item.item_owner, boundary, item.item_id, item.item_id, item.item_owner,
    claim.event_at, new Date(observedAt).toISOString());
  const values = [commitAt, claim.event_at, ...(progress ? [progress.activity_at] : [])];
  const instants = values.map(value => Date.parse(value));
  if (instants.some((instant, index) => !Number.isFinite(instant) || instant > observedAt || new Date(instant).toISOString() !== values[index])) return null;
  return new Date(Math.max(...instants)).toISOString();
}
