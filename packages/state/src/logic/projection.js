/** The optional engine-20 fields of a fact, present only when its event set them. */
export function decisionFields(detail) {
  return { ...(detail.implies ? { implies: detail.implies } : {}), ...(detail.decision ? { decision: detail.decision } : {}),
    ...(detail.supersededBy ? { supersededBy: detail.supersededBy } : {}) };
}

/** Give facts the same stamped identity on CLI, API, export and replica reads; a never-again keeps its cause [B29,B31,D1]. */
export function factFromEvent(event) {
  const detail = JSON.parse(event.event_detail);
  return { id: detail.id, eventId: event.event_id, kind: detail.kind, text: detail.text,
    by: event.event_by, at: event.event_at, ref: detail.ref ?? null, supersedes: detail.supersedes ?? null, ...decisionFields(detail),
    ...(detail.claimId === undefined ? {} : { claimId: detail.claimId }), ...(detail.answers === undefined ? {} : { answers: detail.answers }),
    ...(detail.neverAgain ? { cause: detail.cause, neverAgain: true } : {}) };
}

