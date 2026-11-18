/** The one write of the verdict table: the immutable native verdict row of a review [V1,B3]. */

/**
 * Insert the immutable native verdict and return its row id.
 *
 * @param {any} board
 * @param {{ item_id: number, item_commit: string }} item
 * @param {{ agentId: string, decision: string, reason: string, note: string, digest: string, head: string, family: string }} verdict
 * @returns {number | bigint}
 */
export function insertVerdict(board, item, { agentId, decision, reason, note, digest, head, family }) {
  return board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note,
    verdict_commit, verdict_digest, verdict_head, verdict_verifier_family, verdict_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.item_id, agentId, decision, reason, note.trim(), item.item_commit,
    digest, head, family, board.clock.now().toISOString()).lastInsertRowid;
}
