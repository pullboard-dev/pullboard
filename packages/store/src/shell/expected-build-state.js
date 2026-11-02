/** Replicated item estimates use native metadata, just like check timing [N2,B3,H16]. */

/** Persist only an explicitly authored estimate; clearing it leaves its duration unknown. */
export function saveExpectedBuildMinutes(board, id, value) {
  if (value === undefined) return;
  const key = `item_expected_build_minutes:${id}`;
  if (value === null) board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run(key);
  else board.db.prepare('INSERT OR REPLACE INTO board_meta(meta_key,meta_value) VALUES(?,?)').run(key, JSON.stringify(value));
}
