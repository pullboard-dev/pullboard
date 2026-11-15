/**
 * The one module that writes the board's key-value table: every other writer asks here (registry owner, #6745).
 * Why: 106 raw-SQL sites wrote board_meta from 62 files, so no module could say what its keys meant.
 */

/** Set a board_meta key, replacing any value it held. */
export function writeBoardMeta(db, key, value) {
  db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value').run(key, value);
}

/** Remove a board_meta key. */
export function deleteBoardMeta(db, key) {
  db.prepare('DELETE FROM board_meta WHERE meta_key=?').run(key);
}
