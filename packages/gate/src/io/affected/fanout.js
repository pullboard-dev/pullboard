/** Summarise why a gate selected the tests it did, so an over-wide selection is visible at a glance [C7,V4]. */

/**
 * The fan-out of one selection: the changed files, the selected test count, and the most common reasons.
 * A reason is grouped by its kind (the changed file for an import chain, the cause for a forced-in closure).
 *
 * @param {{ files: string[], reasons?: Record<string, string> }} selection what selectAffectedTests returned
 * @param {string[]} changed the changed paths
 * @param {number} [top] how many reason groups to list
 * @returns {{ changed: string[], selected: number, top: { reason: string, count: number }[] }}
 */
export function selectionFanOut(selection, changed, top = 5) {
  const counts = new Map();
  for (const reason of Object.values(selection.reasons ?? {})) {
    const kind = reason.includes(' -> ') ? `reached from ${reason.split(' -> ')[0]}` : reason.replace(/^unresolved closure: [^:]*:?\s*/u, 'unresolved closure: ').slice(0, 120);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return { changed: [...changed], selected: selection.files.length,
    top: [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, top) };
}
