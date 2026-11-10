/** Piecewise clock windows of complete native state, separate from continuously refreshed flow [H5,H16,A2]. */
import { qualifyingLandingTimes } from "../../../roadmap/index.js";

const HOUR = 3_600_000;

/** Derive the next real projected block or pace transition from the already captured business snapshot. */
export function nativeStateClockWindow(state, history, items, observedAt) {
  let nextChange = null;
  /** Retain one earliest transition without allocating or spreading a board-sized timestamp array. */
  function consider(at) {
    if (Number.isFinite(at) && at > observedAt && (nextChange === null || at < nextChange)) nextChange = at;
  }
  for (const item of state.items ?? []) {
    const lastActivity = Date.parse(item.progress?.lastActivity);
    if (Number.isFinite(lastActivity)) consider(lastActivity + (Math.floor((observedAt - lastActivity) / 60_000) + 1) * 60_000);
  }
  for (const agent of state.agents ?? []) {
    const at = Date.parse(agent.lastMoveAt);
    // The activity window includes the exact four-hour boundary.
    consider(at);
    consider(at + 4 * HOUR + 1);
  }
  for (const block of state.blocks ?? []) {
    // readBlocks includes an entry at exactly its twenty-four-hour boundary.
    consider(Date.parse(block.at) + 24 * HOUR + 1);
  }
  if (state.milestones?.length || state.dashboardPace) {
    const current = new Map(items.map(item => [item.item_id, item]));
    for (const at of qualifyingLandingTimes(history, current)) {
      // A future-dated observation enters at its timestamp; strict pace windows expire on the boundary.
      for (const offset of [0, 2 * HOUR, 6 * HOUR, 24 * HOUR]) consider(at + offset);
    }
  }
  return { observedAt, nextChange };
}

/** A cached piecewise state remains valid only forward within its measured clock interval. */
export function nativeStateClockMatches(window, observedAt) {
  return Boolean(window && observedAt >= window.observedAt && (window.nextChange === null || observedAt < window.nextChange));
}
