/** Browser-safe relay request contract [C7]. */

/** Adapt one explicit request capability to the shared relay transport interface. */
export function createRelayAdapter(request) {
  if (typeof request !== 'function') throw new TypeError('relay adapter needs a request handler');
  return Object.freeze({ request });
}

/** Make an isolated test transport from an explicit request handler. */
export function createFakeRelayAdapter(handler) { return createRelayAdapter(handler); }
