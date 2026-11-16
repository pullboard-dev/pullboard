// pullboard: browser
/** @pullboard-test-input source-cell apps/relay */
/** @pullboard-test-gui */
/** A paired browser opts in to OS notifications per kind through a service worker [C7]. */
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { findChromeExecutable } from '../../../cli/tests/fixtures/relay/browser.js';
import { startChrome } from '../../../cli/tests/fixtures/relay/browser.js';

const BROWSER = new URL('../../src/io/browser/', import.meta.url);
const deviceKey = randomBytes(32);

/** Seal a notice as the board machine does: kind byte, iv, tag, then the AES-256-GCM body. */
function sealedWakeup(kindByte, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deviceKey, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Uint8Array.from([kindByte, ...iv, ...cipher.getAuthTag(), ...body]);
}

/** A localhost page server (a secure context) that serves the two browser files and records what the page posts. */
async function serve(t) {
  const posted = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let text = '';
      req.on('data', chunk => { text += chunk; });
      req.on('end', () => { posted.push(JSON.parse(text)); res.end('{}'); });
      return;
    }
    const file = { '/push-client.js': 'push-client.js', '/push-sw.js': 'push-sw.js' }[req.url];
    if (!file) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body>opt-in</body>'); return; }
    res.writeHead(200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/' });
    res.end(readFileSync(new URL(file, BROWSER)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, posted };
}

test('clause 1: in real Chrome the opt-in registers a service worker, subscribes with the relay key and stores the chosen kinds [C7]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const { origin, posted } = await serve(t);
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.navigate(origin + '/');
  await chrome.waitFor('document.readyState === "complete"');
  // Headless Chrome has no push service, so a stand-in pushManager answers subscribe; the registration and cache are the browser's own.
  const task = await chrome.startTask(`import('/push-client.js').then(async client => {
    const seen = [];
    const pushManager = { subscribe: async options => { seen.push(Array.from(new Uint8Array(options.applicationServerKey))); return { toJSON: () => ({ endpoint: 'https://push.example/e1', keys: { p256dh: 'p', auth: 'a' } }) }; } };
    const result = await client.optInToPush({ kinds: ['alerts', 'landings', 'bogus'], publicKey: 'AQIDBA', deviceKey: new Uint8Array(32).fill(7), pushManager,
      post: body => fetch('/subscribe', { method: 'POST', body: JSON.stringify(body) }) });
    const registration = await navigator.serviceWorker.getRegistration();
    const state = await (await (await caches.open('pullboard-push')).match('/push-state.json')).json();
    return { result, worker: registration?.active?.scriptURL ?? registration?.installing?.scriptURL ?? registration?.waiting?.scriptURL, key: seen[0], kinds: state.kinds };
  })`, 'opt in to push');
  const outcome = await chrome.pollTask(task);
  assert.equal(outcome.worker, origin + '/push-sw.js');
  assert.deepEqual(outcome.key, [1, 2, 3, 4]);
  assert.deepEqual(outcome.kinds, ['alerts', 'landings']);
  assert.deepEqual(outcome.result, { kinds: ['alerts', 'landings'], endpoint: 'https://push.example/e1' });
  assert.deepEqual(posted, [{ subscription: { endpoint: 'https://push.example/e1', keys: { p256dh: 'p', auth: 'a' } }, kinds: ['alerts', 'landings'] }]);
});

/** Load the worker with a stand-in self and cache; returns the shown notices and a way to push bytes at it. */
async function worker(state) {
  const shown = [];
  const handlers = {};
  const cache = new Map(state ? [['/push-state.json', JSON.stringify(state)]] : []);
  globalThis.self = { addEventListener: (type, handler) => { handlers[type] = handler; }, registration: { showNotification: async (title, options) => { shown.push({ title, options }); } } };
  globalThis.caches = { open: async () => ({ match: async url => (cache.has(url) ? new Response(cache.get(url)) : undefined) }) };
  await import('../../src/io/browser/push-sw.js?' + Math.random());
  return {
    shown,
    async push(data) {
      let work;
      handlers.push({ data: data === null ? null : { arrayBuffer: async () => Uint8Array.from(data).buffer }, waitUntil: promise => { work = promise; } });
      await work;
    },
  };
}

test('clause 2: the service worker shows a one-line notice from a sealed wake-up and never from plaintext [C7]', async () => {
  const { shown, push } = await worker({ key: Array.from(deviceKey), kinds: ['alerts'] });
  await push(sealedWakeup(1, 'Item 12 needs you\nsecond line is dropped'));
  assert.deepEqual(shown.map(entry => entry.title), ['Item 12 needs you']);
  await push(sealedWakeup(0, 'a decision the person did not choose'));
  await push(new TextEncoder().encode('{"title":"plaintext board text that is long enough to pass"}'));
  await push(Uint8Array.from([1, ...randomBytes(40)]));
  await push(null);
  assert.equal(shown.length, 1, 'a kind not chosen, plaintext, a wrong seal and an empty push show nothing');
});

test('clause 2: without an opt-in the worker shows nothing for a sealed wake-up [C7]', async () => {
  const { shown, push } = await worker(null);
  await push(sealedWakeup(1, 'Item 12 needs you'));
  assert.equal(shown.length, 0);
});
