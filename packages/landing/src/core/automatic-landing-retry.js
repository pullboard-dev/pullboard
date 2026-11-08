/**
 * Refusals that say the landing's machinery could not run, not that the batch or an item failed: a busy board, a locked
 * slot database, or a gate whose only non-green shards are runner refusals. They are retried and never park an item.
 * Why here: the repeat guard (core) and the landing steps (shell) must judge the same codes [C7,#3693].
 */
export const LANDING_FAULT_CODES = Object.freeze(['BOARD_BUSY', 'SLOT_DB_LOCKED', 'LAND_RUNNER_FAULT']);

/** A new accepted main may repair diagnostics or executor admission, never an attributed item defect [B35,C7]. */
export function retryableLandingRefusal(code) {
  return code === 'LAND_DIAGNOSTIC' || code === 'SLOT_DB_LOCKED' || code === 'LAND_GATE_TIMEOUT' || code === 'LAND_RUNNER_FAULT'
    || typeof code === 'string' && code.startsWith('RUNNER_');
}

/** Retire only an unowned diagnostic/infrastructure block when a different main can repair it [B35,C7]. */
export function retryableLandingBatch(batch, main) {
  return batch.state === 'blocked' && batch.base !== main && !batch.supersededByMain && !batch.dropped
    && !(batch.culprits?.length) && !(batch.blocked ?? []).some(entry => entry.code === 'ITEM_HELD')
    && retryableLandingRefusal(batch.refusal?.code);
}
