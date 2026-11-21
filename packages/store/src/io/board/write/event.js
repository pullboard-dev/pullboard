/** One board event as a prepared statement and params for commitPrepared, with logEvent's exact row semantics [C7,R2]. */
import { eventAppendStatement } from "../event/log.js";

/**
 * Build the statement that appends one event, for commitPrepared's `statements`. Every read the row needs happens in
 * this call, before any transaction opens, and nothing is read inside it, so the row is exact unless the board changes
 * before commit (the caller's snapshot check catches that). The row has no hash chain or sequence field: event_id is
 * SQLite's own autoincrement. It does not run logEvent's follow-on writes: the proof-counter fold and the hold lifts need
 * the new event_id and board state, so they stay outside this builder (proof counters catch up from the event table).
 *
 * @param {any} board
 * @param {{ by: string, kind: string, itemId: number | null, detail?: object, at?: Date }} event
 * @returns {{ sql: string, params: unknown[] }}
 */
export function prepareEventAppend(board, { by, kind, itemId, detail = {}, at }) {
  return eventAppendStatement(board, by, kind, itemId, detail, at);
}
