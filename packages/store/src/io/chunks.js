/** Serialise a board document in pieces, so a document past one JavaScript string still exports, hashes and syncs [C7]. */

/**
 * The text JSON.stringify(value, null, indent) would give, as consecutive pieces no larger than one row.
 * Why: a board's events can total more than a string may hold (about 512 MB), so export and the digest never join them.
 *
 * @param {any} value
 * @param {number} [indent] - Spaces per level; 0 for compact text.
 * @param {number} [whole] - The depth from which a value is stringified whole: 3 for an export (document, tables, rows, then one row each).
 * @param {number} [depth]
 * @returns {Generator<string>}
 */
export function* jsonChunks(value, indent = 0, whole = 3, depth = 0) {
  const pad = level => (indent ? '\n' + ' '.repeat(indent * level) : '');
  const plain = value !== null && typeof value === 'object' && typeof value.toJSON !== 'function';
  if (!plain || depth >= whole) {
    const text = JSON.stringify(value, null, indent || undefined);
    yield indent && depth ? text.replaceAll('\n', pad(depth)) : text;
    return;
  }
  const array = Array.isArray(value);
  const entries = array ? value.map((item, index) => [index, item]) : Object.entries(value).filter(([, item]) => item !== undefined && typeof item !== 'function' && typeof item !== 'symbol');
  yield array ? '[' : '{';
  let first = true;
  for (const [key, item] of entries) {
    yield (first ? '' : ',') + pad(depth + 1) + (array ? '' : JSON.stringify(key) + (indent ? ': ' : ':'));
    first = false;
    const hole = array && (item === undefined || typeof item === 'function' || typeof item === 'symbol');
    yield* hole ? ['null'] : jsonChunks(item, indent, whole, depth + 1);
  }
  yield (entries.length ? pad(depth) : '') + (array ? ']' : '}');
}

/**
 * Hand a document to `write` as the same text JSON.stringify(document, null, indent) gives, in pieces of about 1 MB.
 *
 * @param {any} document
 * @param {(text: string) => void} write
 * @param {number} [indent]
 */
export function writeJsonChunks(document, write, indent = 0) {
  let held = '';
  for (const piece of jsonChunks(document, indent)) {
    held += piece;
    if (held.length >= 1 << 20) { write(held); held = ''; }
  }
  if (held) write(held);
}
