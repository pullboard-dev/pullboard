/** Scoped relay HTTP boundary: callers keep origin, authentication, and retry policy [C7]. */
import { AsyncLocalStorage } from 'node:async_hooks';

const adapters = new AsyncLocalStorage();

/** Forward to the platform transport at call time, preserving its response and error semantics. */
export const realRelayAdapter = Object.freeze({
  request(url, options) { return globalThis.fetch(url, options); },
});

/** Make a test transport from an explicit request handler. */
export function createFakeRelayAdapter(handler) {
  if (typeof handler !== 'function') throw new TypeError('relay fake needs a request handler');
  return Object.freeze({ request(url, options) { return handler(url, options); } });
}

/** Select a relay transport for one async chain without changing concurrent callers. */
export function withRelayAdapter(adapter, work) {
  if (typeof adapter?.request !== 'function') throw new TypeError('relay adapter needs request');
  return adapters.run(adapter, work);
}

/** Send one request using the scoped adapter or the real transport. */
export function relayFetch(url, options) {
  return (adapters.getStore() ?? realRelayAdapter).request(url, options);
}
