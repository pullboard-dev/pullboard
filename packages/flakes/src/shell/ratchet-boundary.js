/** Where the landing flake ratchet starts counting, shared by the ratchet and quarantine backfill [C7,D1]. */

/** The last landed batch or merged ratchet receipt, its recorded snapshot, and the event its pairs count after [C7]. */
export function ratchetBoundary(board) {
  const row = board.db.prepare(`SELECT event_id, event_kind, event_detail FROM event WHERE json_valid(event_detail) AND
    (event_kind='landing_batch' AND json_extract(event_detail, '$.batch.state')='landed'
      OR event_kind='merged' AND json_type(event_detail, '$.flakeRatchet')='object') ORDER BY event_id DESC LIMIT 1`).get();
  const detail = row ? JSON.parse(row.event_detail) : null;
  const previous = row ? (row.event_kind === 'merged' ? detail.flakeRatchet : detail.batch.flakeRatchet) ?? null : null;
  return { row, previous, afterEvent: previous?.eventId ?? row?.event_id ?? 0 };
}

/** Each fixed ledger test and the event its repair merged at; pairs before that merge are not live flakes. */
export function repairedAt(board, ledger) {
  return new Map(ledger.filter(row => row.status === 'fixed' && row.item != null).map(row => [JSON.stringify([row.file, row.name]),
    board.db.prepare("SELECT MAX(event_id) AS id FROM event WHERE event_kind='merged' AND item_id=?").get(row.item).id]));
}
