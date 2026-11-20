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

/** The response headers as one plain object with lowercase names, so a caller reads link or x-ratelimit-remaining without a Headers class. */
function plainHeaders(headers) {
  return Object.fromEntries([...headers.entries()].map(([name, value]) => [name.toLowerCase(), value]));
}

/** The response body: JSON only when the content type says so, else the text; a response that names no headers keeps today's JSON read. */
async function responseBody(response) {
  if (!response.headers) return response.json();
  return String(response.headers.get('content-type') ?? '').includes('json') ? response.json() : response.text();
}

/**
 * The real form: one request to a path of the base (api.github.com by default) through the injected fetch, with no token logic.
 * `request(path, { method, headers, body, signal })` sends the method (GET by default), the caller's headers over the default accept header,
 * a text or JSON body as given, and never follows a redirect (redirect 'manual'); a caller's signal reaches the fetch. Returns { status, headers, body }.
 */
export function createGithubAdapter(fetchImpl, { base = BASE } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('github adapter needs a fetch function');
  const root = apiBase(base);
  return Object.freeze({
    async request(path, { method = 'GET', headers, body, signal } = {}) {
      const response = await fetchImpl(`${root}${apiPath(path)}`, {
        method, headers: { accept: 'application/vnd.github+json', ...headers }, redirect: 'manual',
        ...(body !== undefined ? { body } : {}), ...(signal ? { signal } : {}),
      });
      return { status: response.status, ...(response.headers ? { headers: plainHeaders(response.headers) } : {}), body: await responseBody(response) };
    },
  });
}

/**
 * The fake form: answers each request from a table keyed by path (a GET) or by "METHOD path", and answers 404 for any other.
 * An answer is { status, body } with optional headers. Returns { status, body } plus the answer's headers when it names some.
 */
export function createFakeGithubAdapter(table = {}) {
  return Object.freeze({
    async request(path, { method = 'GET' } = {}) {
      const key = apiPath(path);
      const answer = table[`${method} ${key}`] ?? (method === 'GET' ? table[key] : undefined);
      return answer ? { status: answer.status, ...(answer.headers ? { headers: answer.headers } : {}), body: answer.body } : { status: 404, body: { message: 'Not Found' } };
    },
  });
}
