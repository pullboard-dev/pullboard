/** The rolling landing pace every milestone's summary carries: one value for the board, sent once beside a delta, never inside each milestone [C7]. */
export function milestonePace(milestones) {
  return Array.isArray(milestones) ? milestones.find((entry) => entry?.summary?.pace)?.summary.pace : undefined;
}

/** A milestone as its change fingerprint holds it: its own entries, without the board-wide pace that moves every minute. */
export function milestoneWithoutPace(entry) {
  if (!entry?.summary || !Object.hasOwn(entry.summary, 'pace')) return entry;
  const { pace: _pace, ...summary } = entry.summary;
  return { ...entry, summary };
}
