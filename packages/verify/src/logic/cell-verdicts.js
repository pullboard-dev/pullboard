/** The pure store of per-cell verdicts by verdict key: a verdict is reused only under the key it was recorded with [C7,R38,S10]. */

/**
 * A copy of the store with one cell's verdict recorded under its key; the given store is left as it was.
 * Why: the store is plain data a later slice persists, and a shared mutable object would let one cell's record move another's.
 *
 * @param {Record<string, { key: string, verdict: unknown }>} store - Cell name to its recorded key and verdict.
 * @param {string} cell - The cell the verdict is for.
 * @param {string} key - The cell's verdict key when the verdict was reached (cellVerdictKey).
 * @param {unknown} verdict - The verdict to keep.
 * @returns {Record<string, { key: string, verdict: unknown }>} The new store.
 */
export function recordCellVerdict(store, cell, key, verdict) {
  return { ...store, [cell]: { key, verdict } };
}

/**
 * The verdict recorded for a cell when its key is the same, else null so the cell re-verifies.
 * Why: a changed key means a file or a reached contract changed, and the old verdict no longer speaks for the cell.
 *
 * @param {Record<string, { key: string, verdict: unknown }>} store - Cell name to its recorded key and verdict.
 * @param {string} cell - The cell asked about.
 * @param {string} key - The cell's current verdict key.
 * @returns {unknown} The recorded verdict, or null.
 */
export function cellVerdict(store, cell, key) {
  const record = Object.hasOwn(store, cell) ? store[cell] : undefined;
  return record && record.key === key ? record.verdict : null;
}
