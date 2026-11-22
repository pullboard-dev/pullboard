/** Ordered shared-session counters without raw native identifiers or invented item splits [N2,C7]. */
export function sharedSessionTotals(board) {
  return board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key LIKE 'shared-cost:%'").all().map((row) => JSON.parse(row.meta_value));
}
