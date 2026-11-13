/** The pipeline stage an item is in, derived once for show, list, the board read and status [C7]. */
import { handoffRecords } from "../../io/submit/handoff/records.js";
import { pulledGateRecords } from "../../io/submit/handoff/records.js";

/** Stage names in pipeline order; status counts print them in this order. */
export const ITEM_STAGES = ['open', 'building', 'in the gate', 'back with builder', 'in review', 'accepted', 'landed', 'withdrawn'];

/**
 * The stage of one stored item row, from its status and the latest submit hand-off (the record on the item's gate job,
 * parsed or as text) and whether its commit reached main.
 * A claim whose lease lapsed reads as open unless its own gate is queued or running, as the board's other readers do.
 * Why one helper: a claim stays 'claimed' from claim through the whole gate queue and a red gate, so the raw status hid
 * where the work sat; every reader now names the stage from this one function.
 *
 * @param {any} item a stored item row (raw, before lapsed claims are read as open)
 * @param {any} handoff the latest submit hand-off record, its JSON text, or null
 * @param {boolean} landed whether a merged event exists for the item
 * @param {string} at ISO time of the observation
 * @returns {string} one of ITEM_STAGES
 */
export function itemStage(item, handoff, landed, at) {
  let job = null;
  try { job = typeof handoff === 'string' ? JSON.parse(handoff) : handoff ?? null; } catch { job = null; }
  const state = job?.state;
  if (item.item_status === 'verified') return landed ? 'landed' : 'accepted';
  // A withdrawn item with a merged event was recorded by a forced merge: hand-landed work counts as landed.
  if (item.item_status === 'withdrawn') return landed ? 'landed' : 'withdrawn';
  if (item.item_status === 'submitted') return 'in review';
  const sameBar = !job?.digest || job.digest === item.item_frozen_digest;
  const red = state === 'red' && sameBar;
  if (item.item_status === 'claimed') {
    if (['queued', 'running'].includes(state) && job.agentId === item.item_owner) return 'in the gate';
    if ((item.item_lease_until ?? '') > at) return red && job.agentId === item.item_owner ? 'back with builder' : state === 'green' && sameBar ? 'in review' : 'building';
  }
  return red && job.agentId !== undefined && item.item_verdict !== 'REJECT' ? 'back with builder' : 'open';
}

/**
 * Item counts by stage over the whole board, in ITEM_STAGES order, zero stages included.
 *
 * @param {any} board
 * @returns {Record<string, number>}
 */
export function stageCounts(board) {
  const counts = Object.fromEntries(ITEM_STAGES.map(stage => [stage, 0]));
  const at = board.clock.now().toISOString();
  const records = handoffRecords(board.db);
  const pulled = pulledGateRecords(board.db);
  const rows = board.db.prepare(`SELECT item.*,
      EXISTS (SELECT 1 FROM event WHERE event.item_id=item.item_id AND event.event_kind='merged') AS landed
    FROM item WHERE NOT EXISTS (SELECT 1 FROM board_meta redirect WHERE redirect.meta_key='item_redirect:' || item.item_id)`).all();
  for (const row of rows) counts[itemStage(row, pulled.get(row.item_id) ?? records.get(row.item_id) ?? null, Boolean(row.landed), at)]++;
  return counts;
}
