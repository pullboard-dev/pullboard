/** Browser-safe relay request contract [C7]. */

/** Adapt one explicit request capability to the shared relay transport interface. */
export function createRelayAdapter(request) {
  if (typeof request !== 'function') throw new TypeError('relay adapter needs a request handler');
  return Object.freeze({ request });
}

/** Make an isolated test transport from an explicit request handler. */
export function createFakeRelayAdapter(handler) { return createRelayAdapter(handler); }

/** Audit executions explicitly select real adapters locally and on remote runners; it lives beside the adapters so the light door loads one module less [C7]. */
export function auditAdapterEnvironment(audit) {
  return audit ? { PULLBOARD_TEST_REAL: 'all', PULLBOARD_ADAPTER_AUDIT: '1' } : {};
}
