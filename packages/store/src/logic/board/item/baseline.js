/** Read an observation only when it still describes the item's current check command. */
export function itemCheckBaseline(board, item) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`item_check_baseline_${item.item_id}`);
  if (!row) return null;
  const baseline = JSON.parse(row.meta_value);
  return baseline.command === item.item_check ? baseline : null;
}
