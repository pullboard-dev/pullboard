/** @pullboard-test-input source-tree */
/**
 * The star line's hosted fixture (#727) [N26]: a stand-in for pullboard.dev that serves the real hosted page signed
 * out (/out), signed in (/in), and signed in on the machine whose view it reads (/in-local), with the account's
 * linked list, a relay transport and this machine's view all owned by the test. In the page, its fixed local address,
 * 127.0.0.1:4890, is this fixture on /in-local and answers nothing elsewhere, so the proof never reaches a real view.
 */
import { readFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
} from 'node:http';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../../index.js';
import {
  fetchLive,
  machine,
  project,
  startView,
} from './harness.js';
import { press } from './stable.js';
export { STAR_TEXT, starRepository } from '../../../../view/index.js';

/**
 * Start the fixture. `state.account` is the account's linked list as the relay serves it, or a 401 while `state.refused`
 * holds, as for a session the relay no longer accepts; `state.relay` says whether
 * the relay transport lists the board; `requests` counts each path asked for.
 *
 * @returns {Promise<{origin: string, live: object, board: object, state: {account: object[], relay: boolean}, requests: Map<string, number>, script: string, close: () => Promise<void>}>}
 */
export async function starLineFixture() {
  const box = machine();
  project(box, 'star-line');
  const live = await startView(box);
  const board = (await (await fetchLive(live.base + '/api/v1/boards', { headers: { 'x-pullboard-key': live.key } })).json()).boards[0];
  const state = { account: [], relay: false, refused: false };
  const requests = new Map();
  /** The hosted page as the relay serves it, signed in or not. */
  const page = (relaySession) => cockpitPage('', { readOnly: true, requests: relaySession, transportModule: '/star-transport.js', apiHeaders: {}, stylesheet: '/view.css', hostedLocal: true, relaySession, signIn: '/auth/github/start' });
  let origin = '';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.set(url.pathname, (requests.get(url.pathname) || 0) + 1);
    /** Answer with a body of a type. */
    const send = (type, body, status = 200) => response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    if (['/in', '/in-local', '/out'].includes(url.pathname)) return send('text/html; charset=utf-8', page(url.pathname !== '/out'));
    if (url.pathname === '/star-transport.js') return send('text/javascript', "export async function createTransport() { return { async request(path) { return (await fetch('/relay' + path)).json(); } }; }");
    if (url.pathname === '/view.css') return send('text/css', readFileSync(new URL("../../../../view/src/io/main.css", import.meta.url), 'utf8'));
    // The account's linked list: metadata only, read by the page on its own origin.
    if (url.pathname === '/api/v1/boards' && state.refused) return send('application/json', JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: 'Sign in.' } }), 401);
    if (url.pathname === '/api/v1/boards') return send('application/json', JSON.stringify({ version: 1, boards: state.account }));
    if (url.pathname === '/lv/local/protocol') return send('application/json', JSON.stringify({ version: 1, apiVersion: 1, hostedOrigin: origin }));
    // This machine's view answers reads and streams through the fixture, with its key.
    if (url.pathname.startsWith('/lv/')) return proxy(live.base + url.pathname.slice(3) + url.search, request, response);
    if (url.pathname.startsWith('/relay/') && (state.relay || url.pathname !== '/relay/api/v1/boards')) return proxy(live.base + url.pathname.slice(6) + url.search, request, response);
    if (url.pathname === '/relay/api/v1/boards') return send('application/json', JSON.stringify({ version: 1, boards: [] }));
    return send('application/json', JSON.stringify({ error: 'not in this fixture' }), 404);
  });
  /** Read the owned view with its key and pass the answer on as it comes, an event stream included. */
  function proxy(address, request, response) {
    const headers = { 'x-pullboard-key': live.key, accept: request.headers.accept || '*/*', ...(request.headers['last-event-id'] ? { 'last-event-id': request.headers['last-event-id'] } : {}) };
    const upstream = httpRequest(address, { headers, agent: false }, (reply) => {
      response.writeHead(reply.statusCode || 502, { 'content-type': reply.headers['content-type'] || 'application/json', 'cache-control': 'no-store' });
      reply.pipe(response);
    });
    response.once('close', () => upstream.destroy());
    upstream.once('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    upstream.end();
  }
  origin = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  // Run before each page: on /in-local, 127.0.0.1:4890 is this fixture and the tab starts with its local session;
  // anywhere else nothing answers there, so the page never starts its round trip to a real view.
  const script = `{ const f = window.fetch, local = 'http://127.0.0.1:4890', here = location.pathname === '/in-local';
    window.fetch = (input, init) => { const url = String(input?.url ?? input); return !url.startsWith(local) ? f(input, init) : here ? f(${JSON.stringify(origin)} + '/lv' + url.slice(local.length), init) : Promise.reject(new TypeError('no local view here')); };
    if (here) sessionStorage.setItem('pullboard.local.session', JSON.stringify({ version: 1, origin: local, key: ${JSON.stringify(live.key)} })); }`;
  return { origin, live, board, state, requests, script, close: () => Promise.all([live.stop(), new Promise((resolve) => server.close(resolve))]) };
}

/** The star line as the page shows it: its words, link, line boxes and parts, or null while it is not on screen. */
export const STAR_SHOWN = "(() => { const p = document.querySelector('#star-line'); return p && !p.hidden && getComputedStyle(p).display !== 'none' ? { text: p.textContent, href: p.querySelector('a').href, lines: p.querySelector('a').getClientRects().length, parts: p.children.length, count: document.querySelectorAll('.star-line').length } : null; })()";

/**
 * Steps on the fixture's pages in one Chrome: open or reload a page and wait until it has drawn its boards and read
 * the account's linked list (linked: 'yes' or 'no'), optionally with a new list and with the request counts
 * started afresh, read the line, and dismiss it.
 *
 * @param {object} chrome - A shared-wait Chrome client.
 * @param {{origin: string, state: {account: object[]}, requests: Map<string, number>}} star - The fixture.
 */
export function starSteps(chrome, star) {
  /** Wait for a fresh page at a path to have read its boards and the account's list. */
  const ready = (path, linked) => chrome.waitFor(`!window.__stale && location.pathname === ${JSON.stringify(path)} && data !== null && !document.body.classList.contains('loading') && document.querySelector('#star-line')?.dataset.linked === ${JSON.stringify(linked)}`);
  return {
    shown: () => chrome.stable(STAR_SHOWN),
    async open(path, linked, account = star.state.account) {
      star.state.account = account;
      star.requests.clear();
      await chrome.stable('window.__stale = true');
      await chrome.send('Page.navigate', { url: star.origin + path });
      await ready(path, linked);
    },
    async reload(linked) {
      const path = await chrome.stable('(window.__stale = true, location.pathname)');
      await chrome.send('Page.reload', {});
      await ready(path, linked);
    },
    async dismiss() {
      await press(chrome, "document.querySelector('#star-dismiss')");
      await chrome.waitFor(`${STAR_SHOWN} === null && localStorage.getItem('pb.star') === 'dismissed'`);
    },
  };
}
