// pullboard: browser
/** @pullboard-test-gui */
/** Hosted installation and pairing-storage behavior use real HTTP and Chrome [H5,H15,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { requestPairingPersistence } from '../apps/relay/index.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { findChromeExecutable, relayWorkBudgetMs, startChrome } from './relay-browser-fixture.js';

test('a paired phone page is installable and asks to keep its storage [H5,H15,C7]', async t => {
  const box = await relayClientFixture(t);
  const shell = await fetch(box.origin + '/', { signal: AbortSignal.timeout(relayWorkBudgetMs()) });
  assert.equal(shell.status, 200);
  const html = await shell.text();
  const manifestLink = /<link\s+rel="manifest"\s+href="([^"]+)"/u.exec(html);
  assert.ok(manifestLink, 'the actual hosted page advertises its web app manifest');
  assert.equal(new URL(manifestLink[1], box.origin).origin, box.origin);
  const policy = shell.headers.get('content-security-policy');
  assert.match(policy, /default-src 'none'/u);
  assert.match(policy, /manifest-src 'self'/u);
  assert.match(policy, /worker-src 'self'/u);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/u);

  const response = await fetch(new URL(manifestLink[1], box.origin));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/manifest\+json/u);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const manifest = await response.json();
  assert.equal(manifest.name, 'Pullboard');
  assert.equal(manifest.display, 'standalone');
  assert.equal(new URL(manifest.start_url, box.origin).href, box.origin + '/');
  assert.equal(new URL(manifest.scope, box.origin).href, box.origin + '/');
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(value => value.sizes === `${size}x${size}` && value.type === 'image/png');
    assert.ok(icon, `the manifest has a real ${size}px raster fallback`);
    const address = new URL(icon.src, box.origin);
    assert.equal(address.origin, box.origin);
    const downloaded = await fetch(address);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('content-type'), /image\/png/u);
    const png = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  const worker = await fetch(box.origin + '/service-worker.js');
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get('content-type'), /javascript/u);
  assert.equal(worker.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(box.origin + '/relay/not-a-public-asset.js')).status, 401,
    'an unlisted path still requires authentication');
  const session = await box.phoneSession();
  assert.equal((await fetch(box.origin + '/relay/not-a-public-asset.js', {
    headers: { authorization: 'Bearer ' + session.token },
  })).status, 404, 'even an authenticated caller cannot fetch arbitrary filesystem paths');

  await t.test('persistence permission grants, refusals and unsupported browsers are handled [H5,H15]', async () => {
    let calls = 0;
    assert.equal(await requestPairingPersistence({ storage: { persist: async () => { calls += 1; return true; } } }), true);
    assert.equal(calls, 1);
    assert.equal(await requestPairingPersistence({ storage: { persist: async () => false } }), false);
    assert.equal(await requestPairingPersistence({ storage: { persist: async () => { throw new Error('fixture denial'); } } }), false);
    assert.equal(await requestPairingPersistence({}), false);
  });

  await t.test('real pairing requests storage once and the worker controls the page [H5,H15,C7]', {
    skip: !findChromeExecutable() && 'Chrome is not installed',
  }, async () => {
    const title = 'INSTALLABLE_PAIRED_BOARD';
    assert.equal((await box.cli('add', box.lane, title)).code, 0);
    await box.link();
    const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
    const encoded = readFileSync(box.keyFile, 'utf8').trim();
    const chrome = await startChrome();
    try {
      await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.setInterval = () => 0;
          window.pairingPersistenceCalls = 0;
          Object.defineProperty(navigator.storage, 'persist', { value: async () => {
            window.pairingPersistenceCalls += 1;
            return location.search === '?granted';
          } });`,
      });
      const cookie = await chrome.send('Network.setCookie', {
        name: 'pb_session', value: session.token, url: box.origin, httpOnly: true, sameSite: 'Lax',
      });
      assert.equal(cookie.success, true, 'the private browser has a real person session');
      await chrome.navigate(box.origin + '/');
      await chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes('pair this browser')");
      assert.equal(await chrome.evaluate('window.pairingPersistenceCalls'), 0, 'an unpaired visit does not ask to retain pairing');
      await chrome.waitFor('navigator.serviceWorker.controller !== null', undefined, 'the served worker controls the hosted page');
      assert.equal(await chrome.evaluate('navigator.serviceWorker.controller.scriptURL'), box.origin + '/service-worker.js');
      await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + encoded);
      await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(title) + ')');
      assert.equal(await chrome.evaluate('window.pairingPersistenceCalls'), 1,
        'successful pairing asks the browser to retain its storage');
      const warning = await chrome.evaluate("document.querySelector('#pairing-storage-notice')?.textContent");
      assert.equal(typeof warning, 'string', 'a refused persistence request is visible after pairing');
      assert.match(warning, /Home Screen/u);
      assert.doesNotMatch(warning, /\n/u, 'a refused storage request is explained in one line');
      await chrome.evaluate("import('/relay/client.js').then(async module => { const transport = await module.createTransport(); await transport.request('/api/v1/boards'); })");
      assert.equal(await chrome.evaluate("document.querySelectorAll('#pairing-storage-notice').length"), 1,
        'later board refreshes keep one warning');
      assert.equal(await chrome.evaluate('window.pairingPersistenceCalls'), 2,
        'a second transport asks once for its retained pairing, not once per refresh');
      await chrome.navigate(box.origin + '/?granted');
      await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(title) + ')');
      assert.equal(await chrome.evaluate('window.pairingPersistenceCalls'), 1,
        'reopening a retained pairing requests persistence once');
      assert.equal(await chrome.evaluate("document.querySelector('#pairing-storage-notice') === null"), true,
        'granted persistence needs no refusal message');
      assert.deepEqual(await chrome.evaluate('caches.keys()'), [], 'the minimal worker stores no board pages or API responses');
    } finally { await chrome.close(); }
  });
});
