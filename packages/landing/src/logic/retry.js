/**
 * Refusals that say the landing's machinery could not run, not that the batch or an item failed: a busy board, a locked
 * slot database, accepted policy that moved mid-write (#5672), or a gate whose only non-green shards are runner refusals.
 * They are retried and never park an item.
 * Why here: the repeat guard (core) and the landing steps (shell) must judge the same codes [C7,#3693].
 */
export const LANDING_FAULT_CODES = Object.freeze(['BOARD_BUSY', 'SLOT_DB_LOCKED', 'LAND_RUNNER_FAULT', 'POLICY_SNAPSHOT_STALE']);

/**
 * Refusals that end a landing whose batch another wake must finish: the lease was lost (its renewal missed the deadline,
 * or the guardian stopped the worker). The batch is kept for adoption, so the lander logs it and reloads, never crashing.
 * Why: an uncaught LAND_LEASE_LOST killed the automatic lander and stalled landing until the next command (#5770) [C7].
 */
export const LANDING_ADOPT_REFUSALS = Object.freeze(new Set(['LAND_LEASE_LOST', 'LAND_WORKER']));

/** A new accepted main may repair diagnostics or executor admission, never an attributed item defect [B35,C7]. */
export function retryableLandingRefusal(code) {
  return code === 'LAND_DIAGNOSTIC' || code === 'SLOT_DB_LOCKED' || code === 'POLICY_SNAPSHOT_STALE' || code === 'LAND_GATE_TIMEOUT' || code === 'LAND_RUNNER_FAULT'
    || typeof code === 'string' && code.startsWith('RUNNER_');
}

/** Retire only an unowned diagnostic/infrastructure block when a different main can repair it [B35,C7]. */
export function retryableLandingBatch(batch, main) {
  return batch.state === 'blocked' && batch.base !== main && !batch.supersededByMain && !batch.dropped
    && !(batch.culprits?.length) && !(batch.blocked ?? []).some(entry => entry.code === 'ITEM_HELD')
    && retryableLandingRefusal(batch.refusal?.code);
}

/** The first and the largest wait before the lander tries again after a held trunk or a landing with nothing to land [C7]. */
export const LANDING_BACKOFF_FIRST_MS = 60_000;
export const LANDING_BACKOFF_MAX_MS = 300_000;

/** The refusals that mean the trunk itself is held, so no landing can succeed until something changes [C7]. */
export const HELD_TRUNK_REFUSALS = Object.freeze(new Set(['LAND_TEST_DEFECT', 'LAND_FLAKE']));

/** The outcome name of a landing that ran and moved nothing. */
export const NOTHING_TO_LAND = 'NOTHING_TO_LAND';

/**
 * The wait before the next landing attempt: 60 s the first time, doubled up to 5 minutes while the same outcome repeats.
 * Why: on 6 Nov a trunk held by a test defect made the scheduler start a fresh crashing lander on every command,
 * 124 landing leases in 10 minutes on a Mac already at load 60.
 *
 * @param {{ outcome: string, backoffMs: number } | null | undefined} previous - The back-off the attempt that just ended ran under.
 * @param {string} outcome - The refusal code, error name or NOTHING_TO_LAND of the attempt that just ended.
 * @returns {number}
 */
export function nextLandingBackoff(previous, outcome) {
  return previous && previous.outcome === outcome && Number.isSafeInteger(previous.backoffMs) && previous.backoffMs > 0
    ? Math.min(previous.backoffMs * 2, LANDING_BACKOFF_MAX_MS) : LANDING_BACKOFF_FIRST_MS;
}

/**
 * Whether something that can change a backed-off landing's outcome happened since the back-off began: an item became
 * verified (an accept verdict, or a green gate that machine-verified it), or a held test file changed on the trunk.
 * Why: a back-off must never delay work a new verdict, gate or test correction made landable [C7].
 *
 * @param {{ verified: string[], held: Record<string, string | null> } | null | undefined} before - Marks at the back-off's start.
 * @param {{ verified: string[], held: Record<string, string | null> }} after - Marks now.
 * @returns {string | null} The trigger: 'verified' or 'held-file', else null.
 */
export function landingWakeTrigger(before, after) {
  if (!before || !after) return null;
  if ((after.verified ?? []).some(key => !(before.verified ?? []).includes(key))) return 'verified';
  if (Object.entries(before.held ?? {}).some(([file, blob]) => (after.held ?? {})[file] !== blob)) return 'held-file';
  // A waiver recorded since the back-off began can release a held trunk at once; it waited out the back-off on 9 Nov [C7].
  if (Number.isSafeInteger(before.waivers) && Number.isSafeInteger(after.waivers) && after.waivers > before.waivers) return 'waiver';
  return null;
}
