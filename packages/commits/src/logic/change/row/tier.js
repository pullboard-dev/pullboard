/** Authorize a change to the generated test-tier table only when every changed row names a test file in the seat's lane [L3,C7]. */

/** The generated table every seat's new test file regenerates a row of. */
export const TIER_TABLE = 'packages/gate/data/tests/tiers.json';

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

/** The per-file ceiling baselines whose rows follow the lane that owns each test file. */
export const BASELINE_TABLES = ['packages/gate/data/tests/test-fixtures.json', 'packages/gate/data/baselines/test-waits-baseline.json'];

/**
 * Prove a staged change to a ceiling baseline only adds, renames or lowers rows of files this lane owns, and never
 * raises a ceiling: a file already listed may not raise any rule, and the rows of newly listed files (a split's new
 * files) may total no more, per rule, than this change removed or lowered. Why: every view-lane test split was refused
 * because the rows were core's, though a split only moves ceilings and never adds to them [L3,C7].
 *
 * @param {string} path
 * @param {{ before: (path: string) => any, after: (path: string) => any, ownsFile: (file: string) => boolean }} reads
 * @returns {{ allowed: boolean, problem: string | null }}
 */
export function baselineRowChange(path, { before, after, ownsFile }) {
  if (!BASELINE_TABLES.includes(path)) return { allowed: false, problem: null };
  try {
    const old = json(before(path)), next = json(after(path));
    const freed = {}, added = {};
    for (const file of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (JSON.stringify(old[file]) === JSON.stringify(next[file])) continue;
      if (!ownsFile(file)) return { allowed: false, problem: `baseline row for ${file} is outside this lane` };
      const was = old[file], now = next[file] ?? {};
      for (const rule of new Set([...Object.keys(was ?? {}), ...Object.keys(now)])) {
        const delta = (now[rule] ?? 0) - (was?.[rule] ?? 0);
        if (typeof delta !== 'number' || Number.isNaN(delta)) throw Error('row is not a count');
        if (delta < 0) freed[rule] = (freed[rule] ?? 0) - delta;
        else if (delta > 0 && was) return { allowed: false, problem: `baseline row ${file} ${rule} would rise; a ceiling is never raised` };
        else if (delta > 0) added[rule] = (added[rule] ?? 0) + delta;
      }
    }
    for (const rule of Object.keys(added)) {
      if (added[rule] > (freed[rule] ?? 0)) return { allowed: false, problem: `new baseline rows for ${rule} total ${added[rule]}, more than the ${freed[rule] ?? 0} this change removed` };
    }
    return { allowed: true, problem: null };
  } catch {
    return { allowed: false, problem: `${path} cannot be proved as own-lane baseline rows` };
  }
}
