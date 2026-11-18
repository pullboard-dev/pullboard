import { AsyncLocalStorage } from 'node:async_hooks';
const scopes = new AsyncLocalStorage();
/** The environment object beneath the scope proxy, and the proxy this module installed over it. */
let base = process.env, installed = null;
const traps = ['get', 'set', 'has', 'deleteProperty', 'ownKeys', 'getOwnPropertyDescriptor']
  .map(name => [name, (_, key, value) => Reflect[name](scopes.getStore() ?? base, key, value)]);
/**
 * Run body with env as process.env for it and all it awaits (no env: unchanged), so concurrent callers each keep their own.
 * Why: a runner preload or another module may have replaced process.env since load; the proxy is installed over whatever is there now, so env is never silently ignored.
 */
export function withEnvironment(env, body) {
  if (!env) return body();
  if (process.env !== installed) {
    base = process.env;
    installed = new Proxy(base, Object.fromEntries(traps));
    process.env = installed;
  }
  return scopes.run({ ...env }, body);
}
