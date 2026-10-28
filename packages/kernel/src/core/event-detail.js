/** Share an already-decoded event only inside the proof projection, never in native history. */
const decoded = Symbol('proof event detail');

/** Attach an internal decoded value without adding anything to serialized event records. */
export function decodedProofEvent(event, detail) {
  return { ...event, [decoded]: detail };
}

/** Read an internal projection or decode the original immutable event for legacy readers. */
export function proofEventDetail(event) {
  return Object.hasOwn(event, decoded) ? event[decoded] : JSON.parse(event.event_detail);
}
