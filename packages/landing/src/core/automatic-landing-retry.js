/** A new accepted main may repair diagnostics or executor admission, never an attributed item defect [B35,C7]. */
export function retryableLandingRefusal(code) {
  return code === 'LAND_DIAGNOSTIC' || code === 'SLOT_DB_LOCKED' || code === 'LAND_GATE_TIMEOUT'
    || typeof code === 'string' && code.startsWith('RUNNER_');
}

/** Retire only an unowned diagnostic/infrastructure block when a different main can repair it [B35,C7]. */
export function retryableLandingBatch(batch, main) {
  return batch.state === 'blocked' && batch.base !== main && !batch.supersededByMain && !batch.dropped
    && !(batch.culprits?.length) && !(batch.blocked ?? []).some(entry => entry.code === 'ITEM_HELD')
    && retryableLandingRefusal(batch.refusal?.code);
}
