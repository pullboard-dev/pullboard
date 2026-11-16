/** Read-only projection of append-only landing receipts, shared by board operations and clients. */
/** Read the latest append-only snapshot of each landing batch [B3,R3,R2]. */
export function landingBatches(board) {
  // Only each batch's newest snapshot is parsed, in the order its first event was written: a board holds thousands of
  // snapshot events (26 MB of text) and the older ones only ever lose to the newest [C7,H24].
  return board.db.prepare(`SELECT e.event_detail FROM event e JOIN (SELECT MAX(event_id) AS last, MIN(event_id) AS first FROM event
    WHERE event_kind = 'landing_batch' GROUP BY json_extract(event_detail, '$.batch.id')) g ON e.event_id = g.last ORDER BY g.first`)
    .all().map(row => JSON.parse(row.event_detail).batch);
}

/**
 * The landing batches that could own a worktree root: none when no batch event names the root, else every batch.
 * Why: a commit hook asks only whether an active batch owns its own checkout, and almost every checkout is no landing
 * worktree, so one text search answers it without parsing any batch; a batch owns a root only by naming it [C7,H24].
 */
export function landingBatchesAt(board, root) {
  const named = board.db.prepare("SELECT 1 FROM event WHERE event_kind = 'landing_batch' AND instr(event_detail, ?) > 0 LIMIT 1").get(JSON.stringify(String(root)).slice(1, -1));
  return named ? landingBatches(board) : [];
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
