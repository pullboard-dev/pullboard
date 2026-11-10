/**
 * The hosted journeys' browser routing (#935): which owned server answers each request the journey's Chrome makes, and
 * which failed interceptions are reads the journey itself orphaned by navigating. Shared by apps/cli/journeys/shout/journeys.test.js and
 * the routing control in apps/cli/journeys/milestone/routes.test.js.
 */
import assert from 'node:assert/strict';
import { fetchLive } from '../harness.js';

export const JOURNEY_HOSTED = 'https://app.pullboard.dev';
export const JOURNEY_LOCAL = 'http://127.0.0.1:4890';

/** Normalize only resource identifiers in API paths before retaining bounded fixture diagnostics. */
export function journeyApiPathKind(pathname) {
  const names = new Set(['api', 'v1', 'boards', 'state', 'events', 'moves', 'items', 'shouts', 'answers', 'devices', 'session', 'enrollments', 'approvals', 'requests', 'keys']);
  return pathname.split('/').map(part => !part || names.has(part) ? part : ':id').join('/');
}

/**
 * The headers a hosted request is forwarded with. Chrome can pause a request before its network stack attaches
 * cookies, so the paused headers may lack pb_session (#835; chromium-bidi met the same, wpt PR 63104): a missing
 * Cookie header is restored from Chrome's jar for the request's URL. With the CI condition armed, an API request's
 * paused Cookie header is dropped first: on CI the page loaded signed in, then its API reads answered 401. Each API pause records which case it was, never a value.
 *
 * @param {object} chrome - The browser B connection.
 * @param {{url: string, headers: object}} asked - The paused request.
 * @param {{cookieless?: boolean}|null} condition - The CI stand-in, if any.
 * @param {object[]} pauses - Bounded record of API pauses: path kind and 'paused', 'restored', 'replanted' or 'none'.
 */
export async function journeyForwardHeaders(chrome, asked, condition, pauses, planted = null) {
  const address = new URL(asked.url);
  const api = address.pathname.startsWith('/api/');
  let headers = Object.entries(asked.headers).filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase()));
  if (condition?.cookieless && api) headers = headers.filter(([name]) => name.toLowerCase() !== 'cookie');
  const paused = headers.some(([name]) => name.toLowerCase() === 'cookie');
  let restored = false;
  if (!paused) {
    const { cookies } = await chrome.send('Network.getCookies', { urls: [asked.url] });
    if (cookies.length > 0) { headers.push(['Cookie', cookies.map(({ name, value }) => name + '=' + value).join('; ')]); restored = true; }
  }
  // A restart of Chrome's network service empties its in-memory jar. Production's pb_session is persistent (Max-Age)
  // and survives once flushed; the fixture's was planted moments ago, so the journey keeps forwarding it, and counts
  // each time it had to (#902). The document needs it too: the server renders a signed-out page without it.
  let replanted = false;
  if (!paused && !restored && planted) { headers.push(['Cookie', planted]); replanted = true; }
  if (api && pauses.length < 128) {
    pauses.push({ pathKind: journeyApiPathKind(address.pathname), cookie: paused ? 'paused' : restored ? 'restored' : replanted ? 'replanted' : 'none' });
  }
  return headers;
}

/**
 * Whether a retired interception (Invalid InterceptionId) is an API read this journey orphaned by navigating the page
 * away (#935). The old document keeps reading until the new one commits, and Chrome then retires its paused requests
 * without a loadingFailed. Only an /api/ request that paused before a main-frame commit the harness's own navigation
 * caused qualifies; anything else is a real routing failure.
 *
 * @param {string} url - The paused request's URL.
 * @param {number} pausedAt - When it paused (performance.now()).
 * @param {number[]} commits - The main-frame commits that answered the harness's own navigations, one each (performance.now()).
 */
export function journeyNavigationOrphan(url, pausedAt, commits) {
  return new URL(url).pathname.startsWith('/api/') && commits.some((committedAt) => committedAt > pausedAt);
}

/**
 * Fulfill only the hosted document/assets; rewrite live API and local requests to owned HTTP servers. With `slow`
 * armed, the next discovery read of this machine's view answers only after `slow.ms`, once: the CI condition (#786),
 * where a macOS runner's first local answer outlasted the page's three-second wait. Off unless a test arms it.
 *
 * @param {{armed: boolean, ms: number, cookieless?: boolean}|null} [slow] - The stand-in for a slow first discovery answer.
 * @param {object[]} [pauses] - Receives each hosted API pause's cookie case (see journeyForwardHeaders).
 * @returns {Promise<(() => Promise<void>) & {navigate: (url: string) => Promise<void>}>} The stop check, and the only way this journey navigates the page.
 */
export async function routeJourneyOrigins(chrome, site, view, slow = null, pauses = []) {
  const failures = [];
  const orphaned = [];
  const retired = [];
  const failedLoads = new Map();
  const commits = [];
  const tasks = [];
  let navigatedAt = -Infinity;
  // Each harness navigation arms one commit; a commit the page makes on its own never counts (#935 review).
  let awaitingCommit = false;
  // The session cookie this journey planted, forwarded when a network-service restart has emptied the jar (#902).
  const session = { planted: null };
  const listener = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method === 'Network.loadingFailed') {
      failedLoads.set(message.params.requestId, { canceled: message.params.canceled === true, errorText: message.params.errorText });
      return;
    }
    // A main-frame commit after the harness navigated replaces the document whose paused reads Chrome then retires.
    if (message.method === 'Page.frameNavigated' && !message.params.frame?.parentId && awaitingCommit) {
      awaitingCommit = false;
      commits.push(performance.now());
    }
    if (message.method !== 'Fetch.requestPaused') return;
    const pausedAt = performance.now();
    tasks.push((async () => {
      const { requestId, request: asked } = message.params;
      const address = new URL(asked.url);
      if (address.origin === JOURNEY_HOSTED && address.pathname.startsWith('/api/')) {
        // Every hosted API request goes on to the owned site, as live streams always did. Answering one by hand raced
        // the browser for paged object reads, which then failed at Fetch.fulfillRequest with Invalid InterceptionId (#935).
        const headers = (await journeyForwardHeaders(chrome, asked, slow, pauses, session.planted)).map(([name, value]) => ({ name, value }));
        await chrome.send('Fetch.continueRequest', {
          requestId, url: site.base + address.pathname + address.search, headers,
        });
        return;
      }
      if (address.origin === JOURNEY_LOCAL) {
        if (slow?.armed && address.pathname === '/local/protocol') {
          slow.armed = false;
          await new Promise((later) => setTimeout(later, slow.ms)); // budget: the stand-in's one slow answer, longer than the page's 3 s wait; no throughput claim.
          // By now the page has stopped waiting and Chrome has dropped the request, so the late answer has nowhere to go.
          try { await chrome.send('Fetch.continueRequest', { requestId, url: view.base + address.pathname + address.search }); } catch { /* the request the page gave up on */ }
          return;
        }
        await chrome.send('Fetch.continueRequest', { requestId, url: view.base + address.pathname + address.search });
        return;
      }
      if (address.origin !== JOURNEY_HOSTED) throw new Error('unexpected fixture browser origin');
      const headers = Object.fromEntries(await journeyForwardHeaders(chrome, asked, slow, pauses, session.planted));
      const response = await fetchLive(site.base + address.pathname + address.search, {
        method: asked.method, headers, redirect: 'manual',
        ...(asked.postData === undefined ? {} : { body: asked.postData }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = Buffer.from(await response.arrayBuffer());
      await chrome.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: response.status,
        responseHeaders: [...response.headers]
          .filter(([name]) => !['content-length', 'connection', 'transfer-encoding', 'keep-alive', 'date'].includes(name.toLowerCase()))
          .map(([name, value]) => ({ name, value })),
        body: body.toString('base64'),
      });
    })().catch(async (error) => {
      // A request paused before this harness navigated the page away is dropped with its document, and Chrome
      // retires its interception without a loadingFailed. Only that case is set aside; every other error stays a failure (#935).
      // Name the request without its query or ids, and when it paused against the last navigation, so a failure is diagnosable.
      const asked = new URL(message.params.request.url);
      const kind = asked.pathname.startsWith('/api/') ? journeyApiPathKind(asked.pathname) : asked.origin === JOURNEY_LOCAL ? 'local' : 'page';
      const since = Number.isFinite(navigatedAt) ? Math.round(pausedAt - navigatedAt) + ' ms after the last navigation' : 'before any navigation';
      const failure = `${error.message} (${message.params.request.method} ${kind}, ${message.params.resourceType}, paused ${since})`;
      // A retired interception is judged at stop, once every document commit is known: the commit can arrive after the error.
      if (/Invalid InterceptionId/u.test(error.message)) retired.push({ url: message.params.request.url, pausedAt, kind, failure,
        networkId: message.params.networkId ?? null, method: message.params.request.method });
      else failures.push(failure);
      try { await chrome.send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'Failed' }); } catch { /* Chrome may already have closed. */ }
    }));
  };
  chrome.socket.addEventListener('message', listener);
  await chrome.send('Fetch.enable', { patterns: [
    { urlPattern: JOURNEY_HOSTED + '/*', requestStage: 'Request' },
    { urlPattern: JOURNEY_LOCAL + '/*', requestStage: 'Request' },
  ] });
  /** Stop routing and require that no request failed, other than API reads this harness's own navigation orphaned. */
  const stop = async () => {
    chrome.socket.removeEventListener('message', listener);
    await Promise.all(tasks);
    await chrome.send('Fetch.disable');
    for (const entry of retired) {
      if (journeyNavigationOrphan(entry.url, entry.pausedAt, commits)) orphaned.push(entry.kind);
      else failures.push(entry.failure);
    }
    const reported = retired.map(({ kind, method, networkId }) => ({ kind, method, networkId,
      loadingFailed: failedLoads.get(networkId) ?? null }));
    assert.deepEqual(failures, [], `owned hosted and loopback HTTP routes finish without cancelling event streams (orphaned by navigation: ${JSON.stringify(orphaned)}; reported network failures: ${JSON.stringify(reported)})`);
  };
  /** Navigate the page, marking the moment so requests already paused for the old document are known as orphaned. */
  /** Record the session cookie the journey planted, as name=value, for forwarding after a jar reset (#902). */
  stop.plant = (cookie) => { session.planted = cookie; };
  stop.navigate = async (url) => {
    navigatedAt = performance.now();
    awaitingCommit = true;
    await chrome.send('Page.navigate', { url });
  };
  return stop;
}
