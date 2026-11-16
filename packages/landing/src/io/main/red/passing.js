/** Close a Main red item whose named test already passes on current main, with the recorded run as proof [C7,H24]. */
import { mainCheckout } from '../../../../../git/index.js';
import { gitSpawnSync } from '../../../../../git/index.js';
import { cacheFile } from '../red.js';
import { readCache } from '../red.js';

const TITLE = /^Main red: (\S+\.(?:js|mjs|cjs))$/u;

/**
 * Open Main red items whose recorded test file passed on `main`, by a run already recorded for that exact main commit.
 * The cache is keyed by main commit, so an entry is always newer than any claim made on an older main. An item whose
 * file has any red case on that main is kept, whichever cases they are. A file with no recorded run is never closed: the check adds no test run of its own.
 *
 * @param {object[]} items
 * @param {string} main - The current main commit.
 * @param {Record<string, Record<string, {result: string, receiptId?: string, failures?: {name: string}[]}>>} entries
 * @param {string[]} [lineage] - Main's first-parent commits, newest first, ending at `main`.
 * @returns {{ item: number, file: string, receiptId: string, main: string, turnedGreen: string }[]}
 */
export function passingMainReds(items, main, entries, lineage = []) {
  const current = entries?.[main];
  if (!current) return [];
  const found = [];
  for (const item of items) {
    const file = item.item_status === 'open' ? TITLE.exec(item.item_title ?? '')?.[1] : null;
    const outcome = file ? current[file] : null;
    if (!outcome) continue;
    // Any red case keeps the item open, whichever cases they are: the file is the item, not its first failures.
    const stillFailing = outcome.result === 'red' && (!Array.isArray(outcome.failures) || outcome.failures.length > 0);
    if (outcome.result === 'green' || !stillFailing) found.push({ item: item.item_id, file, receiptId: outcome.receiptId ?? 'recorded main run', main,
      turnedGreen: turnedGreenAt(entries, main, file, lineage) });
  }
  return found;
}

/**
 * The first commit of the unbroken run of passing generations that ends at `main` for one file: the landing that turned
 * it green. Why: the cache also holds content-key entries for the same results, so only commits on main's first-parent
 * lineage count, walked newest to oldest. Commits with no recorded result for the file are skipped. A file never recorded
 * red on the lineage, or no lineage, names `main` itself.
 *
 * @param {Record<string, Record<string, {result: string, failures?: unknown}>>} entries
 * @param {string} main
 * @param {string} file
 * @param {string[]} [lineage] - Main's first-parent commits, newest first, ending at `main`.
 * @returns {string}
 */
export function turnedGreenAt(entries, main, file, lineage = []) {
  const passes = outcome => outcome && (outcome.result === 'green' || (outcome.result === 'red' && Array.isArray(outcome.failures) && outcome.failures.length === 0));
  let since = main;
  for (const commit of lineage.filter(key => key !== main && entries?.[key]?.[file])) {
    if (!passes(entries[commit][file])) break;
    since = commit;
  }
  return since;
}

/** Main's first-parent commits, newest first (bounded), or an empty list when Git cannot say. */
function mainLineage(root, commit) {
  try {
    const out = gitSpawnSync(['rev-list', '--first-parent', '-n', '400', commit], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.status === 0 ? String(out.stdout).split('\n').filter(Boolean) : [];
  } catch { return []; }
}

/** The one-line subject of a commit, or an empty string when it cannot be read. */
function subjectOf(root, commit) {
  try {
    const out = gitSpawnSync(['log', '-1', '--format=%s', commit], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.status === 0 ? String(out.stdout).trim().slice(0, 80) : '';
  } catch { return ''; }
}

/**
 * Read this checkout's recorded main runs and name the open Main red items that run proves already fixed.
 * Why lineage only on a find: every `next` asks, and almost always nothing passes, so Git runs only when an item closes
 * (a warm next spent a rev-list on it each time, #8691) [C7,H24].
 */
export function passingMainRedItems(root, items) {
  try {
    const main = mainCheckout(root);
    if (!main?.commit) return [];
    const entries = readCache(cacheFile(root)).entries;
    if (!passingMainReds(items, main.commit, entries).length) return [];
    return passingMainReds(items, main.commit, entries, mainLineage(root, main.commit))
      .map(row => ({ ...row, landing: subjectOf(root, row.turnedGreen) }));
  } catch { return []; }
}
