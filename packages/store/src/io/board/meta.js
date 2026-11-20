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

/**
 * The smallest key above every key that starts with `prefix`, or null when no such key exists (an empty prefix, or one of only top code points).
 * Why: SQLite compares meta_key by its UTF-8 bytes, which order as code points, so raising the last code point by one bounds the prefix's keys.
 *
 * @param {string} prefix
 * @returns {string | null}
 */
function prefixUpperBound(prefix) {
  const points = Array.from(prefix);
  while (points.length) {
    const last = points.pop().codePointAt(0);
    if (last === 0x10ffff) continue;
    // Surrogate code points are not characters, so the key after U+D7FF is U+E000.
    points.push(String.fromCodePoint(last + 1 === 0xd800 ? 0xe000 : last + 1));
    return points.join('');
  }
  return null;
}

/** The WHERE clause and its values for keys that start with `prefix`: a primary-key range, so the meta_key index serves it and its cost never grows with board history. */
function prefixRange(prefix) {
  const upper = prefixUpperBound(prefix);
  // The range finds the rows; the starts-with test keeps the exact rows even where the bound is open-ended.
  return upper === null
    ? { where: 'meta_key >= ? AND substr(meta_key, 1, length(?)) = ?', values: [prefix, prefix, prefix] }
    : { where: 'meta_key >= ? AND meta_key < ? AND substr(meta_key, 1, length(?)) = ?', values: [prefix, upper, prefix, prefix] };
}

/** Every board_meta key and value that starts with `prefix` (the prefix holds no LIKE wildcard), in key order. */
export function listBoardMetaWithPrefix(db, prefix) {
  const { where, values } = prefixRange(prefix);
  return db.prepare(`SELECT meta_key AS key, meta_value AS value FROM board_meta WHERE ${where} ORDER BY meta_key`).all(...values);
}

/** Remove every board_meta key that starts with `prefix` (the prefix holds no LIKE wildcard). */
export function deleteBoardMetaWithPrefix(db, prefix) {
  const { where, values } = prefixRange(prefix);
  db.prepare(`DELETE FROM board_meta WHERE ${where}`).run(...values);
}
