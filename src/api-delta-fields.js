/** Request projections and small decision lists travel whole in every state delta [A2,N26]. */
export const WHOLE_STATE_DELTA_FIELDS = Object.freeze([
  // Observation time belongs to this read, even when a cached build's event sequence is unchanged.
  'observedAt', 'unseen', 'proofStats', 'decisions', 'decisionQueue', 'holds', 'requests', 'personRequests',
]);
