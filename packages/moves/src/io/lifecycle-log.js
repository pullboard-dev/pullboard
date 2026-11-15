/** Read the lifecycle facts and item rows from an open board, read-only [C7]. */

/** The event kinds the lifecycle rules read. */
export const LIFECYCLE_KINDS = ['add', 'edit', 'claim', 'renew', 'release', 'submit', 'reserve', 'accept', 'verify', 'reject', 'reopen', 'merged', 'withdraw', 'hold_item', 'unhold_item', 'refreeze', 'intake', 'outside-intake', 'merge-only-accept'];

/**
 * Read every lifecycle event, in id order, with only the detail fields the rules use.
 * Why json_extract: merged and submit details are large; the rules need a few fields, so SQLite hands back only those.
 *
 * @param {{ db: { prepare: (sql: string) => { all: (...args: any[]) => any[] } } }} board - An open board; only SELECTs run.
 * @returns {{ rows: object[], items: object[] }} Event rows for lifecycleFact(), and the board's item rows.
 */
export function readLifecycleLog(board) {
  const marks = ['idleClaim', 'staleClaim', 'expiredClaim', 'reclaim', 'goneSeat'].map(key => `json_type(d, '$.${key}') IS NOT NULL`).join(' OR ');
  const rows = board.db.prepare(`
    SELECT event_id AS id, event_at AS at, event_by AS by, event_kind AS kind, item_id AS item,
      json_extract(d, '$.after') AS after, json_extract(d, '$.leaseUntil') AS leaseUntil,
      json_extract(d, '$.retainedClaim') AS retained, json_type(d, '$.review') IS NOT NULL AS review,
      json_extract(d, '$.forced') AS forced, json_extract(d, '$.from') AS fromState, json_extract(d, '$.blockedOn') AS blockedOn,
      (${marks}) AS maintenance
    FROM (SELECT *, CASE WHEN json_valid(event_detail) THEN event_detail ELSE '{}' END AS d FROM event
          WHERE item_id IS NOT NULL AND event_kind IN (${LIFECYCLE_KINDS.map(() => '?').join(',')}))
    WHERE event_kind <> 'edit' OR json_type(d, '$.after') IS NOT NULL
    ORDER BY event_id`).all(...LIFECYCLE_KINDS).map(row => ({ ...row, review: Boolean(row.review), maintenance: Boolean(row.maintenance), after: row.after === null ? null : String(row.after), blockedOn: row.blockedOn === null ? null : String(row.blockedOn) }));
  const items = board.db.prepare('SELECT item_id, item_status, item_owner, item_after, item_hold_reason FROM item ORDER BY item_id').all().map(item => ({
    id: item.item_id, status: item.item_status, owner: item.item_owner, held: Boolean(item.item_hold_reason),
    after: String(item.item_after ?? '').split(',').filter(Boolean).map(Number).filter(Number.isInteger),
  }));
  return { rows, items };
}
