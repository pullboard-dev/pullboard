/** The GitHub request adapter: one real form over an injected fetch, one fake form over a table, one contract between them (#1429) [C7]. */
const BASE = 'https://api.github.com';

/** The path a request names, or a refusal when it is not an absolute API path. */
function apiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw Object.assign(new Error(`[GITHUB_PATH_RELATIVE] a GitHub request path starts with a slash, got ${JSON.stringify(path)}; pass a path such as /repos/owner/name`), { name: 'Refused', code: 'GITHUB_PATH_RELATIVE' });
  }
  return path;
}

/** The base a real adapter requests: https anywhere, or http on a loopback host for tests; any other base is refused by name. */
function apiBase(base) {
  let url;
  try { url = new URL(base); } catch { url = null; }
  const loopback = url !== null && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url === null || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw Object.assign(new Error(`[GITHUB_BASE_REFUSED] a GitHub base address is https, or http on localhost, 127.0.0.1 or [::1], got ${JSON.stringify(base)}; pass a base such as https://api.github.com`), { name: 'Refused', code: 'GITHUB_BASE_REFUSED' });
  }
  return base.replace(/[/]+$/u, '');
}

/** The real form: GET one path of the base (api.github.com by default) through the injected fetch, with no token logic; a caller's signal reaches the fetch. Returns { status, body }. */
export function createGithubAdapter(fetchImpl, { base = BASE } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('github adapter needs a fetch function');
  const root = apiBase(base);
  return Object.freeze({
    async request(path, { signal } = {}) {
      const response = await fetchImpl(`${root}${apiPath(path)}`, { method: 'GET', headers: { accept: 'application/vnd.github+json' }, ...(signal ? { signal } : {}) });
      return { status: response.status, body: await response.json() };
    },
  });
}

/** The fake form: answers each path from a table of { status, body } and answers 404 for any other path. Returns { status, body }. */
export function createFakeGithubAdapter(table = {}) {
  return Object.freeze({
    async request(path) {
      const answer = table[apiPath(path)];
      return answer ? { status: answer.status, body: answer.body } : { status: 404, body: { message: 'Not Found' } };
    },
  });
}
