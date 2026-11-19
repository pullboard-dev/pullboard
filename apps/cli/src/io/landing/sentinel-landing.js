/** The landing self-check's ports for `pullboard sentinel run`: the real comparison cache and landing batches [C7,#10125]. */
import { cacheFile } from '../../../../../packages/landing/index.js';
import { readCache } from '../../../../../packages/landing/index.js';
import { landingBatches } from '../../../../../packages/store/index.js';

/**
 * The local main comparison cache as the receipts mainComparisonAlarm reads: one per cached file outcome, red or green.
 * Why: the cache is where landing and submit record every main comparison, so it is the real record the alarm must read.
 *
 * @param {string} root the repository root
 * @returns {object[]} receipts, empty when the cache cannot be read
 */
export function mainComparisonReceipts(root) {
  try {
    return Object.entries(readCache(cacheFile(root)).entries).flatMap(([commit, files]) => Object.entries(files)
      .filter(([, row]) => row.at).map(([file, row]) => ({ id: row.receiptId ?? `${commit}:${file}`, kind: 'main-red', green: row.result === 'green', at: row.at,
        failures: row.result === 'red' ? [{ file, name: row.failures?.[0]?.name ?? 'the whole file fails' }] : [] })));
  } catch { return []; }
}

/** The ports the sentinel hands the health cell's landing self-check. */
export const landingSelfCheckPorts = Object.freeze({ comparisons: mainComparisonReceipts, landingBatches });
