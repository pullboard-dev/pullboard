/** Authorize a change to the generated test-tier table only when every changed row names a test file in the seat's lane [L3,C7]. */

/** The generated table every seat's new test file regenerates a row of. */
export const TIER_TABLE = 'packages/gate/test-tiers.json';

/** Decode exact UTF-8 JSON from a plain blob; anything else fails closed. */
function json(entry) {
  if (!entry || entry.mode !== '100644' || !Buffer.isBuffer(entry.bytes) || entry.bytes.includes(0)) throw Error('not a plain JSON blob');
  return JSON.parse(entry.bytes.toString('utf8'));
}

/**
 * Prove a staged change to the tier table touches only rows for files this lane owns.
 * Rows are compared by their `file` key, so order cannot grant authority; any added, removed or
 * edited row for a file outside the lane, or any change to the rest of the document, refuses.
 *
 * @param {string} path
 * @param {{ before: (path: string) => any, after: (path: string) => any, ownsFile: (file: string) => boolean }} reads
 * @returns {{ allowed: boolean, problem: string | null }}
 */
export function tierRowChange(path, { before, after, ownsFile }) {
  if (path !== TIER_TABLE) return { allowed: false, problem: null };
  try {
    const { files: oldRows, ...oldRest } = json(before(path));
    const { files: newRows, ...newRest } = json(after(path));
    if (JSON.stringify(oldRest) !== JSON.stringify(newRest)) return { allowed: false, problem: `${path} changed outside its rows` };
    const rows = (list) => new Map(list.map(row => [row.file, JSON.stringify(row)]));
    const old = rows(oldRows), next = rows(newRows);
    for (const file of new Set([...old.keys(), ...next.keys()])) {
      if (old.get(file) === next.get(file)) continue;
      if (!ownsFile(file)) return { allowed: false, problem: `tier row for ${file} is outside this lane` };
    }
    return { allowed: true, problem: null };
  } catch {
    return { allowed: false, problem: `${path} cannot be proved as own-lane tier rows` };
  }
}
