/** The rolling landing pace every milestone's summary carries: one value for the board, sent once beside a delta, never inside each milestone [C7]. */
export function milestonePace(milestones) {
  return Array.isArray(milestones) ? milestones.find((entry) => entry?.summary?.pace)?.summary.pace : undefined;
}

/**
 * A milestone as its change fingerprint holds it: its own entries, without the board-wide pace that moves every minute.
 * With `derived` (state.milestoneDelta, #9846) it also leaves out the forecast fields computed from that pace, which move with it.
 */
export function milestoneWithoutPace(entry, derived = false) {
  if (!entry?.summary || !Object.hasOwn(entry.summary, 'pace')) return entry;
  const { pace: _pace, ...summary } = entry.summary;
  if (derived) for (const key of PACE_DERIVED) delete summary[key];
  return { ...entry, summary };
}

/** The summary fields milestoneForecast derives from the pace and the count left. */
const PACE_DERIVED = ['estimate', 'window', 'reason'];
