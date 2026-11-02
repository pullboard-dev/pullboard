/** Browser-safe relay request contract [C7]. */

/** Forward to the runtime transport at call time, preserving response and error semantics. */
export const realRelayAdapter = Object.freeze({
  request(url, options) { return globalThis.fetch(url, options); },
});

/** Make an isolated test transport from an explicit request handler. */
export function createFakeRelayAdapter(handler) {
  if (typeof handler !== 'function') throw new TypeError('relay fake needs a request handler');
  return Object.freeze({ request(url, options) { return handler(url, options); } });
}
