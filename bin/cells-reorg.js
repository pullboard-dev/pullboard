/**
 * Which items the Cells reorg-only checks may refuse [C7]. The fixture-source proof, plan placement, later-cell
 * imports and deleted-path strings guard moves and cuts; on any other item their findings print as warnings (#2473).
 * Editing a body that has already moved is ordinary work; only an in-flight move, its shim or the plan is reorg.
 * #2467 deletes this with the rest of the restructure machinery.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { posix } from 'node:path';

/** Titles of Cells move, cut and shim-removal items, as the plan and the cut tooling write them. */
const REORG_TITLE = /^\s*Cells (?:move|cuts?|import cuts|shims?)\b/iu;

/** Rows keyed by exact JSON, so a changed row is a removal plus an addition. */
const rowKeys = rows => new Set((rows ?? []).map(row => JSON.stringify(row)));

/**
 * A plan change beyond placing the item's own new files or retiring its own deleted ones: a changed or removed row,
 * a moved stay, a cut edge or re-export that names a kept file, or changed cell metadata. --place appends a row
 * and --retire drops one, which ordinary items do.
 */
function planReorg(before, after, added, deleted) {
  const kept = edge => !String(edge).split('->').some(path => deleted.has(path));
  const cuts = cell => (cell.cuts ?? []).map(link => Array.isArray(link.edges) ? { ...link, edges: link.edges.filter(kept) } : link)
    .filter(link => !Array.isArray(link.edges) || link.edges.length).map(link => Array.isArray(link.edges) ? { ...link, imports: link.edges.length } : link);
  // Sorted keys: a rewritten plan may list the same fields in another order.
  const sorted = (key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value;
  const shape = plan => JSON.stringify({ ...plan, totals: null, stays: null, retired: null, cells: plan.cells.map(cell => ({ ...cell,
    paths: null, placedBy: null, reexports: (cell.reexports ?? []).filter(kept), cuts: cuts(cell) })) }, sorted);
  if (shape(before) !== shape(after)) return true;
  const oldRetired = rowKeys(before.retired), newRetired = rowKeys(after.retired);
  if ([...oldRetired].some(row => !newRetired.has(row))) return true;
  if ((after.retired ?? []).some(entry => !oldRetired.has(JSON.stringify(entry)) && !deleted.has(entry?.row?.[0]))) return true;
  const oldStays = rowKeys(before.stays), newStays = rowKeys(after.stays);
  if (before.stays.some(row => !newStays.has(JSON.stringify(row)) && !deleted.has(row.path))) return true;
  if (after.stays.some(row => !oldStays.has(JSON.stringify(row)) && !added.has(row.path))) return true;
  return before.cells.some(cell => {
    const old = rowKeys(cell.paths), now = rowKeys(after.cells.find(row => row.name === cell.name)?.paths);
    return cell.paths.some(row => !now.has(JSON.stringify(row)) && !deleted.has(row[0]))
      || after.cells.find(row => row.name === cell.name).paths.some(row => !old.has(JSON.stringify(row)) && !added.has(row[0]));
  });
}

/**
 * Name why an item is Cells reorg work, or null [C7]. Reorg work is a move, cut or shim-removal item, or one that
 * changes the path map, a shim (a moved path's old location) or plan rows other than its own added or deleted files. Only
 * reorg work is refused by the reorg-only checks; every other item gets their findings as warnings (#2473).
 */
export function cellsReorgReason({ title = '', criterion = '', changed, added, deleted = [], before, after, beforeMap, afterMap }) {
  if ([title, criterion].some(text => typeof text === 'string' && REORG_TITLE.test(text))) return 'the item is a Cells move, cut or shim removal';
  if (beforeMap.size !== afterMap.size || [...afterMap].some(([from, to]) => beforeMap.get(from) !== to)) return 'the item changes path-map.json';
  const shim = changed.find(file => beforeMap.has(file) || afterMap.has(file));
  if (shim) return `the item changes the shim ${shim}`;
  if (changed.some(file => file === 'bin/cells-plan.json' || file.startsWith('bin/cells-plan/')) && planReorg(before, after, new Set(added), new Set(deleted))) {
    return 'the item changes bin/cells-plan.json or bin/cells-plan/ beyond placing its new files or retiring its deleted ones';
  }
  return null;
}

/** One advisory finding: the file and line, what the check found and how to fix it. */
export function warning(file, line, finding, fix) {
  return `cells warning: ${file}:${line || 1}: ${finding}; fix: ${fix}`;
}

/** Fixture-source proof findings name a test or docs reader, a fixture or a data read. */
export function fixtureFinding(problem) {
  return /^(?:test|docs)\//u.test(problem) || /fixture|data read/iu.test(problem);
}

/** A fixture-proof finding as a warning, located at the reader file and line it names. */
export function fixtureWarning(cell, problem) {
  const site = /((?:test|docs)\/[\w./-]+?\.[cm]?js)(?::(\d+))?/u.exec(problem);
  return warning(site?.[1] ?? 'bin/cells-plan.json', Number(site?.[2]), `${cell} --moved: ${problem}`,
    `build the path from a proven fixture input port; the next Cells move of ${cell} must prove it`);
}

/** The first line of an importer that names the imported module, so a later-cell warning points at the import. */
export function importLine(root, file, target) {
  const name = posix.basename(target).replace(/\.[cm]?js$/u, '');
  try { return readFileSync(join(root, file), 'utf8').split('\n').findIndex(line => line.includes(name)) + 1; }
  catch { return 1; }
}
