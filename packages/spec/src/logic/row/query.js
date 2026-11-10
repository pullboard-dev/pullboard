/** Current person decisions, including applied receipts, stored without checkout-dependent state. */
export function rowDecisions(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('row_decisions');
  return row ? JSON.parse(row.meta_value) : [];
}
