/** Read-only projection of append-only landing receipts, shared by board operations and clients. */
/** Read the latest append-only snapshot of each landing batch [B3,R3,R2]. */
export function landingBatches(board) {
  const batches = new Map();
  for (const row of board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'landing_batch' ORDER BY event_id").all()) {
    const { batch } = JSON.parse(row.event_detail);
    batches.set(batch.id, batch);
  }
  return [...batches.values()];
}

/**
 * Read one batch's latest snapshot by selecting only its newest event, parsing a single row.
 * Why: the board write that records a batch looked its previous snapshot up by parsing every batch event ever
 * recorded, holding the SQLite write for the whole history; SQLite filters by id without building JS objects [C7,#3333].
 */
export function latestLandingBatch(board, id) {
  if (typeof id !== 'string') return undefined;
  const row = board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'landing_batch' AND json_extract(event_detail, '$.batch.id') = ? ORDER BY event_id DESC LIMIT 1").get(id);
  return row ? JSON.parse(row.event_detail).batch : undefined;
}
