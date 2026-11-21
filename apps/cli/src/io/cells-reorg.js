/**
 * Which items the Cells reorg-only checks may refuse [C7]. The fixture-source proof, plan placement, later-cell
 * imports and deleted-path strings guard moves and cuts; on any other item their findings print as warnings (#2473).
 * Editing a body that has already moved is ordinary work; only an in-flight move or its shim is reorg.
 * #2467 deletes this with the rest of the restructure machinery.
 */
import { cellReadFileSync as readFileSync } from '../../../../packages/codemap/index.js';
import { join } from 'node:path';
import { posix } from 'node:path';

/** Titles of Cells move, cut and shim-removal items, as the plan and the cut tooling write them. */
const REORG_TITLE = /^\s*Cells (?:move|cuts?|import cuts?|shims?)\b/iu;

/**
 * Name why an item is Cells reorg work, or null [C7]. Reorg work is a move, cut or shim-removal item, or one that
 * changes the path map or a shim (a moved path's old location); plan shards and plan data are never read. Only
 * reorg work is refused by the reorg-only checks; every other item gets their findings as warnings (#2473).
 */
export function cellsReorgReason({ title = '', criterion = '', changed, beforeMap, afterMap }) {
  if ([title, criterion].some(text => typeof text === 'string' && REORG_TITLE.test(text))) return 'the item is a Cells move, cut or shim removal';
  if (beforeMap.size !== afterMap.size || [...afterMap].some(([from, to]) => beforeMap.get(from) !== to)) return 'the item changes path-map.json';
  const shim = changed.find(file => beforeMap.has(file) || afterMap.has(file));
  if (shim) return `the item changes the shim ${shim}`;
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
  return warning(site?.[1] ?? 'packages/codemap/data/plan/cells.json', Number(site?.[2]), `${cell} --moved: ${problem}`,
    `build the path from a proven fixture input port; the next Cells move of ${cell} must prove it`);
}

/** The first line of an importer that names the imported module, so a later-cell warning points at the import. */
export function importLine(root, file, target) {
  const name = posix.basename(target).replace(/\.[cm]?js$/u, '');
  try { return readFileSync(join(root, file), 'utf8').split('\n').findIndex(line => line.includes(name)) + 1; }
  catch { return 1; }
}
