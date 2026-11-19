/**
 * The one place that reads process.env: callers take an adapter, tests pass a fake source [C7].
 * Why: a fake source makes environment-dependent code deterministic without touching the real env.
 */

/**
 * Build an environment adapter over a source of name to value pairs.
 * @param {Record<string, string | undefined>} [source] defaults to the real process environment
 * @returns {{ get: (name: string, fallback?: string) => string | undefined, has: (name: string) => boolean, all: () => Record<string, string | undefined> }}
 */
export function environmentAdapter(source = process.env) {
  return {
    get: (name, fallback) => (source[name] === undefined ? fallback : source[name]),
    has: (name) => source[name] !== undefined,
    all: () => ({ ...source }),
  };
}
