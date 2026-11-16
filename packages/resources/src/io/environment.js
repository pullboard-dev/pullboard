import { AsyncLocalStorage } from 'node:async_hooks';
const scopes = new AsyncLocalStorage(), real = process.env;
const traps = ['get', 'set', 'has', 'deleteProperty', 'ownKeys', 'getOwnPropertyDescriptor']
  .map(name => [name, (_, key, value) => Reflect[name](scopes.getStore() ?? real, key, value)]);
/** Run body with env as process.env for it and all it awaits (no env: unchanged), so concurrent callers each keep their own. */
export function withEnvironment(env, body) {
  if (!env) return body();
  if (process.env === real) process.env = new Proxy(real, Object.fromEntries(traps));
  return scopes.run({ ...env }, body);
}
