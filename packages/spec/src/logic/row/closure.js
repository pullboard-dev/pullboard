/**
 * Every spec row that rests on a row, directly or through other rows, nearest first [C7].
 *
 * A row "serves" the rows named in its `serves` field, so the rows that rest on a rejected row are
 * those whose serves lists reach it. Walks breadth-first so direct servers come before distant ones,
 * lists each row once even when two paths reach it, and stops on a cycle. Pure: no board, no files.
 *
 * @param {{rows: Array<{id: string, serves?: string[]}>}} spec
 * @param {string} id the rejected row
 * @returns {string[]} ids, never including `id` itself; empty for an unknown id
 */
export function servesClosure(spec, id) {
  const rows = spec?.rows ?? [];
  if (!rows.some((row) => row.id === id)) return [];
  const found = [];
  const seen = new Set([id]);
  let frontier = [id];
  while (frontier.length) {
    const next = [];
    for (const target of frontier) {
      for (const row of rows) {
        if (seen.has(row.id) || !(row.serves ?? []).includes(target)) continue;
        seen.add(row.id);
        found.push(row.id);
        next.push(row.id);
      }
    }
    frontier = next;
  }
  return found;
}
