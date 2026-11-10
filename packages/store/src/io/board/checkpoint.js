/** Board WAL checkpoints that never wait on, or hold up, a reader or writer [C7]. */

/** The most WAL bytes kept on disk after a checkpoint has copied them into the board. */
export const BOARD_WAL_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Copy what the WAL holds into the board, PASSIVE only: it copies what no reader still needs and returns at
 * once, never taking a lock a reader waits on. Why PASSIVE: FULL, RESTART and TRUNCATE wait for readers and
 * block new writers, and a board read at that moment hit "database is locked" (#2578). Returns SQLite's counts.
 */
export function checkpointBoard(db) {
  const row = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() ?? {};
  return { busy: row.busy ?? null, walFrames: row.log ?? null, copiedFrames: row.checkpointed ?? null };
}
