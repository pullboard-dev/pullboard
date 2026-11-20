/** Read an observation only when it still describes the item's current check command. */
export function itemCheckBaseline(board, item) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`item_check_baseline_${item.item_id}`);
  if (!row) return null;
  const baseline = JSON.parse(row.meta_value);
  return baseline.command === item.item_check ? baseline : null;
}

/**
 * The open items whose frozen check still needs a timed baseline, oldest first, at most the free runner slots (#1273).
 * A candidate has no baseline record for its current check or one with no seconds, is not in flight (result pending)
 * and is not strict (the record's own strict flag). Slots the caller's runner count minus the items already pending.
 */
export function remeasureCandidates(board, { slots }) {
  const live = board.db.prepare("SELECT * FROM item WHERE item_check != '' AND item_status IN ('open', 'claimed', 'submitted') ORDER BY item_created_at, item_id").all();
  const baselines = live.map(item => ({ item, baseline: itemCheckBaseline(board, item) }));
  const free = slots - baselines.filter(({ baseline }) => baseline?.result === 'pending').length;
  if (!(free > 0)) return [];
  return baselines
    .filter(({ item, baseline }) => item.item_status === 'open' && baseline?.result !== 'pending' && baseline?.strict !== true && !Number.isSafeInteger(baseline?.seconds))
    .slice(0, free).map(({ item }) => item);
}
