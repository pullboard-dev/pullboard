/** Close a Main red item whose named test already passes on current main, with the recorded run as proof [C7,H24]. */
import { mainCheckout } from '../../../git/index.js';
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
 * @returns {{ item: number, file: string, receiptId: string, main: string }[]}
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
    if (outcome.result === 'green' || !stillFailing) found.push({ item: item.item_id, file, receiptId: outcome.receiptId ?? 'recorded main run', main });
  }
  return found;
}

/** Read this checkout's recorded main runs and name the open Main red items that run proves already fixed. */
export function passingMainRedItems(root, items) {
  try {
    const main = mainCheckout(root);
    return main?.commit ? passingMainReds(items, main.commit, readCache(cacheFile(root)).entries) : [];
  } catch { return []; }
}
