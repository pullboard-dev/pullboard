/** Authorize only canonical placements of regular files created by this lane's same change [L3,C7]. */

/** Decode exact UTF-8 JSON; unsupported blobs fail closed. */
function json(entry) {
  if (!entry || entry.mode !== '100644' || !Buffer.isBuffer(entry.bytes) || entry.bytes.includes(0)) throw Error('not a plain JSON blob');
  const text = entry.bytes.toString('utf8');
  if (!Buffer.from(text).equals(entry.bytes)) throw Error('not UTF-8');
  return JSON.parse(text);
}

/** Compare JSON data without letting object key order grant or remove authority. */
function equal(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
}

/** Prove one existing shard changed only by appending unique rows for owned, newly created files.
 * The caller supplies immutable Git reads and checks absence at every relevant ancestry base.
 * Returning the offending row keeps refusal diagnostics actionable without broadening lane ownership.
 */
export function planRowChange(path, { before, after, ownNewFile }) {
  if (!/^bin\/cells-plan\/[^/]+\.json$/u.test(path)) return { allowed: false, problem: null };
  try {
    const index = json(before('bin/cells-plan.json'));
    if (!equal(index, json(after('bin/cells-plan.json')))) return { allowed: false, problem: 'plan index changed' };
    const row = index.cells?.find(cell => cell.file === path);
    if (!row) return { allowed: false, problem: null };
    const old = json(before(path)), next = json(after(path));
    const { paths: oldPaths, ...oldMetadata } = old;
    const { paths: nextPaths, ...nextMetadata } = next;
    if (!equal(oldMetadata, nextMetadata) || old.name !== row.name || old.order !== row.order) return { allowed: false, problem: `${path} metadata changed` };
    if (!Array.isArray(oldPaths) || !Array.isArray(nextPaths) || nextPaths.length <= oldPaths.length) return { allowed: false, problem: `${path} must only append new-file rows` };
    for (let at = 0; at < oldPaths.length; at += 1) {
      if (!equal(oldPaths[at], nextPaths[at])) return { allowed: false, problem: `existing plan row ${JSON.stringify(oldPaths[at])} changed` };
    }
    const occupied = new Set(index.stays?.map(stay => stay.path) ?? []);
    for (const cell of index.cells) {
      for (const placement of json(before(cell.file)).paths) {
        occupied.add(placement[0]); occupied.add(placement[1]);
      }
    }
    const finalRows = index.cells.flatMap(cell => json(after(cell.file)).paths);
    for (const placement of nextPaths.slice(oldPaths.length)) {
      const [source, target, via] = Array.isArray(placement) ? placement : [];
      const safe = typeof source === 'string' && /^(?:src|relay)\//u.test(source)
        && !source.split('/').some(piece => !piece || piece === '.' || piece === '..') && !/[\0\r\n\\]/u.test(source);
      const suffix = safe ? source.slice(source.indexOf('/') + 1) : '';
      if (!safe || placement.length !== 3 || via !== 'rule'
        || !['core', 'shell'].some(part => target === `${old.root}/src/${part}/${suffix}`)
        || occupied.has(source) || occupied.has(target) || !ownNewFile(source)
        || finalRows.filter(row => row[0] === source || row[1] === source).length !== 1
        || finalRows.filter(row => row[0] === target || row[1] === target).length !== 1) {
        return { allowed: false, problem: `new-file plan row ${JSON.stringify(placement)} is not an owned canonical creation` };
      }
      occupied.add(source); occupied.add(target);
    }
    return { allowed: true, problem: null };
  } catch {
    return { allowed: false, problem: `${path} cannot be proved as new-file placements` };
  }
}
