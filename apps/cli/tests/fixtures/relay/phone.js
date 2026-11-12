/** Exercise empty hosted screens in a real, private phone browser without a user's account [H5,H17]. */
import { createServer } from 'node:http';
import { createRelayBrowserHandler } from '../../../../relay/index.js';
import { startChrome } from './browser.js';

/** Serve only synthetic authorized metadata and keep the production browser transport and device storage. */
export async function emptyPhoneFixture(t, { linked = true, savedKey = false, enrolled = false, delayed = false, phone = true, warnings = [], uploadStatus = 'missing' } = {}) {
  const board = { id: 'a'.repeat(32), repository: 'fixture/empty-project' };
  let releaseListing;
  const listingReady = delayed ? new Promise(resolve => { releaseListing = resolve; }) : Promise.resolve();
  const handle = createRelayBrowserHandler({ authenticate: async () => ({ kind: 'session' }) });
  const calls = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    calls.push(path);
    if (path === '/fixture') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Private fixture</title>'); return; }
    if (path.startsWith('/api/')) {
      let body = { version: 1 };
      let status = 200;
      if (path === '/api/v1/boards') { await listingReady; body.boards = linked ? [board] : []; body.warnings = warnings; }
      else if (path === '/api/v1/devices/session') body.account = 'fixture-account';
      else if (/\/devices\/[^/]+\/boards$/u.test(path)) body.wraps = [];
      else if (/\/devices\/[^/]+\/approvals$/u.test(path)) body.approvals = [];
      else if (path.endsWith('/upload-status') && uploadStatus === 'pending') return;
      else if (path.endsWith('/upload-status') && uploadStatus === 'unauthorized') { status = 401; body.error = { code: 'AUTH_REQUIRED', message: 'This optional status is unavailable.' }; }
      else if (path.endsWith('/state')) { status = 404; body.error = { code: 'NO_SNAPSHOT', message: 'The first sealed copy has not arrived.' }; }
      else { status = 404; body.error = { code: 'NO_BOARD', message: 'This synthetic route has no board.' }; }
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return;
    }
    if (!await handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { releaseListing?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const chrome = await startChrome();
  t.after(() => chrome.close());
  if (phone) {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `const privateFetch = window.fetch;
window.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  return ['http://127.0.0.1:4890', 'http://localhost:4890'].includes(url.origin)
    ? Promise.reject(new TypeError('This private phone has no local view')) : privateFetch(input, options);
};` });
  const origin = 'http://127.0.0.1:' + server.address().port;
  await chrome.navigate(origin + '/fixture');
  if (savedKey) await chrome.evaluate(`localStorage.setItem('pullboard.relay.keys.v1', JSON.stringify({ ['a'.repeat(32)]: btoa('x'.repeat(32)).replaceAll('=', '') }))`);
  if (enrolled) await chrome.evaluate(`(async () => {
    const { createDeviceKeys } = await import('/relay/device-keys.js');
    const device = { ...await createDeviceKeys(), account: 'fixture-account' };
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('pullboard-relay-device-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result; const transaction = db.transaction('keys', 'readwrite');
        transaction.objectStore('keys').put(device, 'device');
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    });
  })()`);
  await chrome.navigate(origin);
  return { chrome, calls, board, releaseListing };
}

/** Read only the visible first-screen guidance and copy actions; never return a stored key. */
export async function emptyPhoneScreen(chrome) {
  return chrome.evaluate(`(() => {
    const panel = document.querySelector('#relay-screen');
    return { text: panel?.innerText ?? '', commands: [...(panel?.querySelectorAll('button[data-copy]') ?? [])].filter(button => button.getClientRects().length).map(button => button.dataset.copy),
      visible: panel?.getClientRects().length > 0, screen: document.documentElement.dataset.relayScreen ?? null };
  })()`);
}
