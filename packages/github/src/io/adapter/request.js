/** The GitHub request adapter: one real form over an injected fetch, one fake form over a table, one contract between them (#1429) [C7]. */
const BASE = 'https://api.github.com';

/** The path a request names, or a refusal when it is not an absolute API path. */
function apiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw Object.assign(new Error(`[GITHUB_PATH_RELATIVE] a GitHub request path starts with a slash, got ${JSON.stringify(path)}; pass a path such as /repos/owner/name`), { name: 'Refused', code: 'GITHUB_PATH_RELATIVE' });
  }
  return path;
}

/** The real form: GET one path of api.github.com through the injected fetch, with no token logic. Returns { status, body }. */
export function createGithubAdapter(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new TypeError('github adapter needs a fetch function');
  return Object.freeze({
    async request(path) {
      const response = await fetchImpl(`${BASE}${apiPath(path)}`, { method: 'GET', headers: { accept: 'application/vnd.github+json' } });
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
