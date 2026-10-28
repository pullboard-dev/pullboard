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
