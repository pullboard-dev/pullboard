/** A seat's recorded parent session, read by seats and by the store's agent readers above it [B3,V1,C7]. */

/**
 * Read a seat's immutable parent session digest; unknown parents remain separate seats.
 *
 * Seats write this key when a seat joins, so its reader lives in the seats cell and the store's
 * agent projections import it from here.
 *
 * @param {any} board
 * @param {string} id
 * @returns {string | null}
 */
export function agentParent(board, id) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_parent_session:${id}`)?.meta_value ?? null;
}
