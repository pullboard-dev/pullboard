/** Scoped relay HTTP boundary: callers keep origin, authentication, and retry policy [C7]. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRelayAdapter } from '../../../kernel/light.js';
export { createFakeRelayAdapter } from '../../../kernel/light.js';

/** Node's live relay transport; resolve fetch at call time to preserve its semantics. */
export const realRelayAdapter = createRelayAdapter((url, options) => globalThis.fetch(url, options));

const adapters = new AsyncLocalStorage();

/** Select a relay transport for one async chain without changing concurrent callers. */
export function withRelayAdapter(adapter, work) {
  if (typeof adapter?.request !== 'function') throw new TypeError('relay adapter needs request');
  return adapters.run(adapter, work);
}

/** Send one request using the scoped adapter or the real transport. */
export function relayFetch(url, options) {
  return (adapters.getStore() ?? realRelayAdapter).request(url, options);
}
