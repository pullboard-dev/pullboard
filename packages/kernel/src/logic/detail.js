/** Share an already-decoded event only inside the proof projection, never in native history. */
const decoded = Symbol('proof event detail');
/** Details already decoded for one event row object, so repeated projections over one history parse each row once. */
const memo = new WeakMap();
/** A detail at least this long is decoded only when a reader touches it: most projections skip large proof and gate records. */
const LAZY_DETAIL_CHARS = 1024;

/** Attach an internal decoded value without adding anything to serialized event records. */
export function decodedProofEvent(event, detail) {
  return { ...event, [decoded]: detail };
}

/**
 * A stand-in for a large JSON object detail that parses it on first use and then behaves as that object.
 * Why: a state read walks every event several times but reads fields of only a few kinds; parsing every large
 * proof-run, gate-run and health-scan detail on each read cost seconds on a real board.
 */
function lazyDetail(text) {
  let value;
  /** The parsed object, decoded once. */
  const real = () => (value ??= JSON.parse(text));
  return new Proxy({}, {
    get: (_, key) => Reflect.get(real(), key),
    has: (_, key) => Reflect.has(real(), key),
    ownKeys: () => Reflect.ownKeys(real()),
    getOwnPropertyDescriptor: (_, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(real(), key);
      return descriptor && { ...descriptor, configurable: true };
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(real()),
    set: (_, key, next) => Reflect.set(real(), key, next),
    defineProperty: (_, key, descriptor) => Reflect.defineProperty(real(), key, descriptor),
    deleteProperty: (_, key) => Reflect.deleteProperty(real(), key),
  });
}

/** Read an internal projection or decode the original immutable event for legacy readers. */
export function proofEventDetail(event) {
  if (Object.hasOwn(event, decoded)) return event[decoded];
  const text = event.event_detail;
  if (typeof text !== 'string') return JSON.parse(text);
  const known = memo.get(event);
  if (known !== undefined && known.text === text) return known.detail;
  const detail = text.length >= LAZY_DETAIL_CHARS && text.startsWith('{') && text.endsWith('}') ? lazyDetail(text) : JSON.parse(text);
  memo.set(event, { text, detail });
  return detail;
}
