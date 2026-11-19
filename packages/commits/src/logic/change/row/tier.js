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
 * Split a ceiling document into its per-file rows (every row as `{rule: n}`) and the rest of the document.
 * A table whose shape says `files` keeps its rows under that key; `bare` rows are counts, read as `{ count: n }`;
 * a `total` beside the rows may fall but never rise, so it is not part of the rest. A bare table that stores no total
 * is judged by the sum of its rows, so no slice has to edit one shared line and two slices that delete different
 * rows merge clean; a stored total still compares as written.
 *
 * @param {{ files?: boolean, bare?: boolean } | undefined} shape
 * @param {any} doc
 * @returns {{ rows: Record<string, Record<string, number>>, rest: string, total: number | null }}
 */
function ceilingParts(shape, doc) {
  const nested = shape?.files ? shape : null;
  if (!nested) return { rows: doc, rest: '', total: null };
  const { files, total, ...rest } = doc;
  const rows = Object.fromEntries(Object.entries(files).map(([file, row]) => [file, nested.bare ? { count: row } : row]));
  const summed = nested.bare ? Object.values(files).reduce((sum, count) => sum + count, 0) : null;
  return { rows, rest: JSON.stringify(rest), total: typeof total === 'number' ? total : summed };
}

/** Whether the table's own check vouches that a newly listed file's row was split from a listed file; a throw refuses. */
function coveredSplit(shape, context) {
  return Boolean(shape?.splitCovered?.(context));
}

/**
 * Prove a staged change to a ceiling baseline only adds, renames or lowers rows of files this lane owns, and never
 * raises a ceiling: a file already listed may not raise any rule, and the rows of newly listed files (a split's new
 * files) may total no more, per rule, than this change removed or lowered. Why: every view-lane test split was refused
 * because the rows were core's, though a split only moves ceilings and never adds to them [L3,C7].
 *
 * @param {string} path
 * @param {{ before: (path: string) => any, after: (path: string) => any, ownsFile: (file: string) => boolean, tables?: Record<string, { files?: boolean, bare?: boolean, splitCovered?: (context: object) => boolean }>, read?: (revision: string, path: string) => any }} reads
 *   `tables` adds the source ceiling tables the gate cell owns and names (its CEILING_ROW_TABLES), with each one's row shape;
 *   a shape's `splitCovered` vouches for a new file's row from the file it was split from, reading blobs through `read`.
 * @returns {{ allowed: boolean, problem: string | null }}
 */
export function baselineRowChange(path, { before, after, ownsFile, tables = {}, read }) {
  const shape = Object.hasOwn(tables, path) ? tables[path] : null;
  if (!BASELINE_TABLES.includes(path) && !shape) return { allowed: false, problem: null };
  try {
    const oldParts = ceilingParts(shape, json(before(path))), newParts = ceilingParts(shape, json(after(path)));
    if (oldParts.rest !== newParts.rest) return { allowed: false, problem: `${path} changed outside its file rows` };
    if (newParts.total !== null && oldParts.total !== null && newParts.total > oldParts.total) return { allowed: false, problem: `${path} total would rise; a ceiling is never raised` };
    const old = oldParts.rows, next = newParts.rows;
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
        else if (delta > 0 && !coveredSplit(shape, { file, old, next, read })) added[rule] = (added[rule] ?? 0) + delta;
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
