/** Shared relay fixture work allowances, based on real product request bounds [H16,C7]. */
export const RELAY_REQUEST_BOUND_MS = 10_000;
export const NATIVE_COMMAND_BOUND_MS = 15_000;
export const FIXTURE_SCHEDULING_MARGIN_MS = 10_000;
export const MAX_SNAPSHOT_ATTEMPTS = 6;

/** Allow native work, its declared sequential network attempts, and scheduling headroom. */
export function relayWorkBudgetMs(requests = MAX_SNAPSHOT_ATTEMPTS) {
  return NATIVE_COMMAND_BOUND_MS + requests * RELAY_REQUEST_BOUND_MS + FIXTURE_SCHEDULING_MARGIN_MS;
}
