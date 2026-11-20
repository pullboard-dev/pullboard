/** The landing merged table run over the live board: the store's merged writer reads its refusal and the events of a merge from it [C7,#8268]. */
import { runMergedTable } from '../../logic/board/landing/lease.js';
import { strictFullSuiteOn } from '../../logic/board/landing/lease.js';
import { itemPace } from './sprint-pace.js';

/**
 * Decide a merge with the landing merged table, over the item as it stands before the move writes anything.
 * Why: one table decides the coordinator and forced-reason guards, the verified-only guard, the merged event and a forced merge's withdrawal, so the writer carries no second copy of those rules.
 * Returns null when the table is not available or throws (a store used without its composition root, or a damaged row): the writer then keeps its own rules, so behaviour never changes.
 *
 * @param {{ id: number, status: string, mergedCommit?: string | null }} item - The item row before the move.
 * @param {{ agentId: string, commit: string, forced?: string }} call
 * @param {{ pace?: string, item?: object, base?: string, io?: object }} [strict] - The pace facts from strictFacts: a strict item's frozen pace and the facts its merge reads, a sprint item's pace alone, nothing for steady.
 * @returns {{ refused?: { code: string, message: string, next?: string }, events?: object[] } | null}
 */
export function mergedDecision(item, call, strict = {}) {
  const move = { id: item.id, actor: call.agentId, commit: call.commit, ...(call.forced === undefined ? {} : { forced: call.forced }) };
  try { return runMergedTable(structuredClone({ ...strict, item: { id: item.id, status: item.status, mergedCommit: item.mergedCommit ?? null, ...strict.item } }), move); } catch { return null; }
}

/** SQL reading one field of an event's detail, empty when the detail is not JSON. */
const FIELD = (path) => `json_extract(CASE WHEN json_valid(event_detail) THEN event_detail ELSE '{}' END, '${path}')`;

/** The newest full-suite receipt recorded for a group (a lane), or null when none has been; the push gate redesign writes them as proof-run receipts of kind suite [M2,#9327]. */
function suiteReceipt(board, group) {
  const row = board.db.prepare(`SELECT event_detail FROM event WHERE event_kind = 'proof-run' AND ${FIELD('$.receipt.kind')} = 'suite' AND ${FIELD('$.receipt.suite')} = 'full' AND ${FIELD('$.receipt.group')} = ? ORDER BY event_id DESC LIMIT 1`).get(group);
  try { return row ? JSON.parse(row.event_detail).receipt : null; } catch { return null; }
}

/**
 * What the merged table reads for the item's frozen pace. A sprint item gets its pace alone, so the table decides it by the sprint rows (row submitted lands submitted work).
 * A strict item under landing.strictFullSuite gets its pace, its commit, frozen digest and group (its lane), the setting, and the group's newest full-suite receipt.
 * Returns an empty object for a steady item, and for a strict one with the setting off, so those merge exactly as before; the setting is not even read for a steady or sprint item.
 * The pace is read from the row already loaded, so no pace adds a board read.
 * Why the receipt's own base: the base a suite ran on is what select checked it against before the push, and the store reads no trunk head here; a receipt that names none never counts.
 * With no receipt the table's strict-full-suite row refuses LAND_SUITE_PENDING and writes nothing.
 *
 * @param {any} board
 * @param {{ item_frozen?: string | null, item_frozen_digest?: string | null, item_commit?: string | null, item_lane?: string | null }} row - The item row before the move.
 * @returns {{ pace?: 'sprint' | 'strict', item?: object, base?: string, io?: { strictFullSuite: true, suite: object | null } }}
 */
export function strictFacts(board, row) {
  const pace = itemPace(row);
  if (pace === 'sprint') return { pace: 'sprint' };
  if (pace !== 'strict' || !strictFullSuiteOn()) return {};
  const suite = suiteReceipt(board, row.item_lane);
  return { pace: 'strict', base: suite?.base, item: { pace: 'strict', commit: row.item_commit ?? undefined, digest: row.item_frozen_digest ?? undefined, claimDigest: row.item_frozen_digest ?? undefined, group: row.item_lane ?? undefined }, io: { strictFullSuite: true, suite } };
}
