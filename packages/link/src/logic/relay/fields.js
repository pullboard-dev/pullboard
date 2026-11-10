/** Transport-free local relay status fields shared with offline read commands [C7,H16]. */
/** Expose only the actionable recovery choice; checkpoint ciphertext and local digests stay private. */
export function recoverySummary(state) {
  const skip = Number.isSafeInteger(state?.recovery?.skip) ? state.recovery.skip : 0;
  return { pending: skip > 0, skip, next: skip > 0 ? `pullboard relay recover --skip ${skip}` : '' };
}

/** Preserve the unlinked status document, including a deleted-copy notice when present. */
export function unlinkedRelayStatus(deleted = null) {
  return { linked: false, board: deleted?.board ?? '', url: deleted?.url ?? '', link: '', sequence: 0, behind: 0, recovery: recoverySummary(null),
    ...(deleted ? { deleted: true, notice: 'The relay copy was deleted; your local board is complete. Keep working locally, or run pullboard relay on to link it again.' } : {}) };
}

/** Confirm a recovered checkpoint contains the same durable refusal for the blocked transport slot. */
export function recoveryRefusalMatches(document, recovery) {
  const boardMeta = Array.isArray(document?.tables?.board_meta) ? document.tables.board_meta : [];
  const events = Array.isArray(document?.tables?.event) ? document.tables.event : [];
  const meta = boardMeta.find((row) => row?.meta_key === 'relay_refusal_' + recovery.skip);
  if (!meta || typeof meta.meta_value !== 'string') return false;
  let refusal;
  try { refusal = JSON.parse(meta.meta_value); } catch { return false; }
  if (typeof refusal?.outcome?.error?.code !== 'string' ||
      (recovery.blockerDigest && refusal.record !== recovery.blockerDigest)) return false;
  return events.some((event) => {
    if (event?.event_kind !== 'relay_refused' || typeof event.event_detail !== 'string') return false;
    try {
      const detail = JSON.parse(event.event_detail);
      return detail.sequence === recovery.skip && detail.code === refusal.outcome.error.code;
    } catch { return false; }
  });
}
