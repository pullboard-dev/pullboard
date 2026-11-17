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
  // An item's idle minute is not a window boundary: it moves every second across a board and is patched on read, not rebuilt.
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
  // The dashboard's four-hour counts drop an event once the read clock reaches its age of four hours.
  for (const event of history) {
    if (['merged', 'accept', 'reject', 'reopen', 'shout'].includes(event.event_kind)) consider(Date.parse(event.event_at) + 4 * HOUR);
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

/**
 * Re-derive every idle-minute reading in a cached build for the observed time, without rebuilding the board state.
 * The result stays exact until the earliest next item boundary, so an unchanged minute reuses it as it is.
 *
 * @param {object} entry - The cached build: its state, items lookup and previous idle window.
 * @param {number} observedAt - The observed wall-clock time in milliseconds.
 * @param {Function} derive - Given the patched state, returns the summary, summaryFields and print the entry carries.
 * @returns {object} The same entry, or a copy with the patched state and its derived views.
 */
export function idleEntry(entry, observedAt, derive) {
  if (entry.idleNext !== undefined && observedAt >= entry.idleAt && observedAt < entry.idleNext) return entry;
  let next = Infinity;
  const idle = progress => {
    const at = Date.parse(progress?.lastActivity);
    if (!Number.isFinite(at)) return progress;
    const minutes = Math.max(0, Math.floor((observedAt - at) / 60_000));
    next = Math.min(next, at + (minutes + 1) * 60_000);
    return minutes === progress.idleMinutes ? progress : { ...progress, idleMinutes: minutes };
  };
  const items = entry.state.items.map(item => item.progress ? { ...item, progress: idle(item.progress) } : item);
  const milestones = (entry.state.milestones ?? []).map(milestone => {
    if (!Array.isArray(milestone.items) || !milestone.progress) return milestone;
    const ordered = milestone.items.map(row => row.progress ? { ...row, progress: idle(row.progress) } : row);
    const known = ordered.map(row => row.progress).filter(Boolean);
    return { ...milestone, items: ordered, progress: { ...milestone.progress, idleMinutes: known.length ? Math.min(...known.map(row => row.idleMinutes)) : null } };
  });
  const state = { ...entry.state, items, ...(entry.state.milestones ? { milestones } : {}) };
  return { ...entry, state, ...derive(state), stateJsonFields: null, compact: undefined, compactFields: undefined,
    items: new Map(state.items.map(item => [item.id, item])), idleAt: observedAt, idleNext: next };
}

/** The minutes each stage may last, read from the board settings that already govern it, so the view marks a stage past its limit without a constant of its own [#6940]. */
/** Whole or fractional minutes from a millisecond setting, or null when the setting is absent. */
function minutesOf(ms) {
  return Number.isFinite(ms) && ms > 0 ? ms / 60_000 : null;
}

/**
 * Minutes per stage for the board snapshot. A stage whose setting is absent is left out, never given a default,
 * so the view shows no past-limit mark for it.
 *
 * building: itemBuildBudgetMinutes; gate: check.timeout; pending review: review.starveMinutes;
 * in review: reviewLease; landing: landing.timeout when set.
 *
 * @param {any} config a loaded board config
 * @returns {{ building?: number, gate?: number, 'pending review'?: number, 'in review'?: number, landing?: number }}
 */
export function stageLimits(config) {
  const limits = {
    building: config?.itemBuildBudgetMinutes,
    gate: minutesOf(config?.check?.timeoutMs),
    'pending review': config?.review?.starveMinutes,
    'in review': minutesOf(config?.reviewLeaseMs),
    landing: minutesOf(config?.landing?.timeoutMs),
  };
  return Object.fromEntries(Object.entries(limits).filter(([, minutes]) => Number.isFinite(minutes) && minutes > 0));
}
