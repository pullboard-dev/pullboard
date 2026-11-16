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

/** A board_meta value, or undefined when the key is absent. */
export function readBoardMeta(db, key) {
  return db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key)?.meta_value;
}

/** Every board_meta key and value that starts with `prefix` (the prefix holds no LIKE wildcard), in key order. */
export function listBoardMetaWithPrefix(db, prefix) {
  return db.prepare('SELECT meta_key AS key, meta_value AS value FROM board_meta WHERE substr(meta_key, 1, length(?)) = ? ORDER BY meta_key').all(prefix, prefix);
}

/** Remove every board_meta key that starts with `prefix` (the prefix holds no LIKE wildcard). */
export function deleteBoardMetaWithPrefix(db, prefix) {
  db.prepare("DELETE FROM board_meta WHERE substr(meta_key, 1, length(?)) = ?").run(prefix, prefix);
}
