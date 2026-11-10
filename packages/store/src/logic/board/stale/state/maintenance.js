/** Pure maintenance candidates; only the ordered coordinator adapter may apply them [B4,H16]. */

/** Require complete measured evidence before proposing an automatic state mutation. */
function measured(entry) {
  return entry.evidence?.complete === true && Number.isFinite(entry.ageMs) && Number.isFinite(entry.limitMs);
}

/** Retain exact row/revision bindings; conditional holds wait for the separately defined condition authority. */
export function planStaleState(snapshot) {
  const timedHolds = snapshot.holds.filter(entry => measured(entry) && entry.scope === 'item' && entry.actor === 'coordinator' && entry.until === null);
  return { observedAt: snapshot.observedAt, observedRevision: snapshot.observedRevision,
    holdWarnings: timedHolds.filter(entry => !entry.expired && entry.limitMs - entry.ageMs <= snapshot.limits.warning),
    holdExpiries: timedHolds.filter(entry => entry.expired),
    reviewReleases: snapshot.reviews.filter(entry => measured(entry) && entry.expired) };
}
