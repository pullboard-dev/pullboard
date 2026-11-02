/** Scoped relay HTTP boundary: callers keep origin, authentication, and retry policy [C7]. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { realRelayAdapter } from '../../../kernel/core.js';
export { realRelayAdapter, createFakeRelayAdapter } from '../../../kernel/core.js';

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
