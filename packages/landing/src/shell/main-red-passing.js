/** Close a Main red item whose named test already passes on current main, with the recorded run as proof [C7,H24]. */
import { mainCheckout } from '../../../git/index.js';
import { gitSpawnSync } from '../../../git/index.js';
import { cacheFile } from './main-red.js';
import { readCache } from './main-red.js';

const TITLE = /^Main red: (\S+\.(?:js|mjs|cjs))$/u;

/**
 * Open Main red items whose recorded test file passed on `main`, by a run already recorded for that exact main commit.
 * The cache is keyed by main commit, so an entry is always newer than any claim made on an older main. An item whose
 * file is red is kept, unless the run names its failing cases and none of the item's recorded failing cases is among
 * them. A file with no recorded run is never closed: the check adds no test run of its own.
 *
 * @param {object[]} items
 * @param {string} main - The current main commit.
 * @param {Record<string, Record<string, {result: string, receiptId?: string, failures?: {name: string}[]}>>} entries
 * @returns {{ item: number, file: string, receiptId: string, main: string, turnedGreen: string }[]}
 */
export function passingMainReds(items, main, entries) {
  const current = entries?.[main];
  if (!current) return [];
  const found = [];
  for (const item of items) {
    const file = item.item_status === 'open' ? TITLE.exec(item.item_title ?? '')?.[1] : null;
    const outcome = file ? current[file] : null;
    if (!outcome) continue;
    const named = (item.item_check_baseline?.testEvidence?.failedCases ?? []).filter(row => row.file === file).map(row => row.name);
    const stillFailing = outcome.result === 'red' && (!Array.isArray(outcome.failures) || !named.length
      || outcome.failures.some(row => named.includes(row.name)));
    if (outcome.result === 'green' || !stillFailing) found.push({ item: item.item_id, file, receiptId: outcome.receiptId ?? 'recorded main run', main,
      turnedGreen: turnedGreenAt(entries, main, file) });
  }
  return found;
}

/**
 * The first recorded main commit of the unbroken run of passing generations that ends at `main` for one file: the landing
 * that turned it green. Why: the closing fact must name that landing, not only the newest main. A file never recorded red
 * before `main` names `main` itself.
 *
 * @param {Record<string, Record<string, {result: string, failures?: unknown}>>} entries - Insertion order is landing order.
 * @param {string} main
 * @param {string} file
 * @returns {string}
 */
export function turnedGreenAt(entries, main, file) {
  const passes = outcome => outcome && (outcome.result === 'green' || (outcome.result === 'red' && Array.isArray(outcome.failures) && outcome.failures.length === 0));
  let since = main;
  for (const commit of Object.keys(entries ?? {}).reverse().filter(key => key !== main && entries[key]?.[file])) {
    if (!passes(entries[commit][file])) break;
    since = commit;
  }
  return since;
}

/** The one-line subject of a commit, or an empty string when it cannot be read. */
function subjectOf(root, commit) {
  try {
    const out = gitSpawnSync(['log', '-1', '--format=%s', commit], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.status === 0 ? String(out.stdout).trim().slice(0, 80) : '';
  } catch { return ''; }
}

/** Read this checkout's recorded main runs and name the open Main red items that run proves already fixed. */
export function passingMainRedItems(root, items) {
  try {
    const main = mainCheckout(root);
    return main?.commit ? passingMainReds(items, main.commit, readCache(cacheFile(root)).entries)
      .map(row => ({ ...row, landing: subjectOf(root, row.turnedGreen) })) : [];
  } catch { return []; }
}
