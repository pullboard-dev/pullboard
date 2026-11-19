import { itemFiles } from './files.js';

/**
 * The ids of the largest set of candidates whose files share no path, in the candidates' order. A candidate with no
 * files collides with nothing, so it is in every result. Ties go to the set that keeps the earlier candidates, so the
 * same input always gives the same ids. Why: first-fit can leave a wave smaller than the best one when an early item
 * touches many files; lists are small, so an exact search is cheap and needs no heuristic.
 *
 * @param {any[]} candidates items with item_id, item_files and item_brief, as itemFiles reads them
 * @returns {Array<number | string>}
 */
export function largestDisjointWave(candidates) {
  const sets = candidates.map((candidate) => new Set(itemFiles(candidate)));
  let best = [];
  const taken = new Set();
  const chosen = [];

  /** Extend the chosen set from candidate `at`, keeping the first largest set found (include before exclude). */
  function search(at) {
    if (chosen.length + (sets.length - at) <= best.length) return;
    if (at === sets.length) {
      best = [...chosen];
      return;
    }
    const files = sets[at];
    if (![...files].some((file) => taken.has(file))) {
      for (const file of files) taken.add(file);
      chosen.push(at);
      search(at + 1);
      chosen.pop();
      for (const file of files) taken.delete(file);
    }
    search(at + 1);
  }

  search(0);
  return best.map((at) => candidates[at].item_id);
}
