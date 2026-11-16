/**
 * Pure import-edge diff [C7]: given two import graphs ({ importer: [resolved module paths] }), return exactly the
 * edges present after and absent before, as sorted { from, to } rows. Edges are keyed by the full resolved path of both
 * ends, never the basename, so two modules named alike in different folders are never taken for one another.
 */
export function addedImportEdges(before = {}, after = {}) {
  const had = new Set();
  for (const [from, targets] of Object.entries(before ?? {})) for (const to of targets ?? []) had.add(JSON.stringify([from, to]));
  const added = new Map();
  for (const [from, targets] of Object.entries(after ?? {})) {
    for (const to of targets ?? []) {
      const key = JSON.stringify([from, to]);
      if (!had.has(key)) added.set(key, { from, to });
    }
  }
  return [...added.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}
