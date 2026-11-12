// pullboard: browser
/** @pullboard-test-gui */
/** Actual relay cockpit request capability and exported read-only guards [H12,H5]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../../index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import {
  findChromeExecutable,
  startChrome,
} from '../../../tests/fixtures/relay/browser.js';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import { createRelayBrowserHandler } from '../../../../relay/index.js';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import {
  emptyPhoneFixture,
  emptyPhoneScreen,
} from '../../../tests/fixtures/relay/phone.js';
import { tapTouch } from '../../../tests/fixtures/cockpit/stable.js';
import { stableChrome } from '../../../tests/fixtures/cockpit/stable.js';

const chromeOptions = { skip: !findChromeExecutable() && 'Chrome is not installed' };

test('a signed-in phone names its empty-board blocker and one next step [N26,H5,H17]', chromeOptions, async t => {
  await t.test('no linked board is claimed only after the authorized listing answers', async t => {
    const box = await emptyPhoneFixture(t, { linked: false, delayed: true });
    await box.chrome.waitFor("document.readyState === 'complete' && document.documentElement.dataset.relayDevice === 'phone'");
    const before = await emptyPhoneScreen(box.chrome);
    box.releaseListing();
    assert.equal(before.visible, true);
    assert.equal(before.text.includes('pullboard relay on --all'), false, 'an unanswered inventory cannot prove that nothing is linked');
    assert.deepEqual(before.commands, [], 'an unknown account offers no command to copy');
    await box.chrome.waitFor("document.querySelector('#relay-screen')?.innerText.includes('No linked boards')");
    const shown = await emptyPhoneScreen(box.chrome);
    assert.ok(shown.commands.includes('pullboard relay on --all'), 'sharing is appropriate only for the confirmed empty account');
  });
  await t.test('linked board and unpaired browser', async t => {
    const box = await emptyPhoneFixture(t);
    await box.chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes('fixture/empty-project')");
    const shown = await emptyPhoneScreen(box.chrome);
    assert.match(shown.text, /not paired/iu);
    assert.match(shown.text, /open.*link.*here/iu);
    assert.ok(shown.commands.includes('pullboard relay pair --new-browser'));
    assert.equal(shown.text.includes('pullboard relay on --all'), false);
  });
  await t.test('known board key but no first copy', async t => {
    const box = await emptyPhoneFixture(t, { savedKey: true });
    await box.chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes('waiting for its first snapshot')");
    const shown = await emptyPhoneScreen(box.chrome);
    assert.match(shown.text, /fixture\/empty-project/u);
    assert.match(shown.text, /first (?:copy|snapshot)/iu);
    assert.ok(shown.commands.includes('pullboard relay status'));
    assert.equal(shown.text.includes('pullboard relay on --all'), false);
  });
  await t.test('paired browser has no keys for the linked boards', async t => {
    const box = await emptyPhoneFixture(t, { enrolled: true });
    await box.chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes('fixture/empty-project')");
    assert.ok(box.calls.some(path => /\/devices\/[^/]+\/boards$/u.test(path)), 'the browser actually authenticated its saved device and fetched its empty grants');
    const shown = await emptyPhoneScreen(box.chrome);
    assert.match(shown.text, /linked boards.*none.*read/iu);
    assert.match(shown.text, /keys/iu);
    assert.ok(shown.commands.includes('pullboard relay pair --new-browser'));
    assert.equal(shown.text.includes('pullboard relay on --all'), false);
  });
});

test('a phone keeps waiting visible when its optional size notice stalls or refuses authentication [H5,H17]', chromeOptions, async t => {
  for (const uploadStatus of ['pending', 'unauthorized']) await t.test(uploadStatus, async t => {
    const box = await emptyPhoneFixture(t, { savedKey: true, uploadStatus });
    await box.chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes('waiting for its first snapshot')", 3000, // budget: the existing three-second hosted board screen ceiling, independent of optional I/O.
      'the waiting screen does not depend on the optional size response');
    const shown = await emptyPhoneScreen(box.chrome);
    assert.equal(shown.visible, true);
    assert.match(shown.text, /waiting for its first snapshot/iu);
    assert.doesNotMatch(shown.text, /too (?:big|large)|sign in again/iu, 'no authenticated size diagnosis or session loss was established');
    assert.ok(box.calls.some(path => path.endsWith('/upload-status')), 'the real optional read was attempted without blocking the screen');
  });
});

test('a signed-in second computer names a linked board blocker without asking to share again [H5,H17]', chromeOptions, async t => {
  for (const [name, options, command] of [
    ['unpaired', {}, 'pullboard relay pair --new-browser'],
    ['first copy missing', { savedKey: true }, 'pullboard relay status'],
    ['paired without grants', { enrolled: true }, 'pullboard relay pair --new-browser'],
  ]) await t.test(name, async t => {
    const box = await emptyPhoneFixture(t, { ...options, phone: false });
    await box.chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes('fixture/empty-project')");
    const shown = await emptyPhoneScreen(box.chrome);
    assert.equal(shown.visible, true, 'the actual desktop person can read this guidance');
    assert.ok(shown.commands.includes(command));
    assert.equal(shown.text.includes('pullboard relay on --all'), false);
  });
});

test('a phone shows its account quota warning while its already-linked board still needs pairing [H5,H17]', chromeOptions, async t => {
  const message = 'Fixture relay storage is full. Run pullboard relay status on the computer with this board.';
  const box = await emptyPhoneFixture(t, { warnings: [{ code: 'ACCOUNT_STORAGE_LIMIT', message }] });
  await box.chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes('Fixture relay storage is full')");
  const shown = await emptyPhoneScreen(box.chrome);
  assert.equal(shown.visible, true);
  assert.ok(shown.text.includes(message), 'the actual quota warning is visible in the phone screen, not hidden under it');
  assert.match(shown.text, /not paired/iu, 'the independently observed pairing blocker still names its own step');
  assert.ok(shown.commands.includes('pullboard relay pair --new-browser'));
  assert.equal(shown.text.includes('pullboard relay on --all'), false, 'a linked board is not asked to share again');
});

/**
 * A page condition that holds once the control keeps the same box and screen across three polls.
 * Why: the approval panel moves between the first screen and the board shell while the page settles, and a tap aimed before that move lands on empty space.
 */
function settled(selector) {
  return `(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    const key = [rect.x, rect.y, rect.width, rect.height, document.documentElement.dataset.relayScreen].join();
    window.settledRun = window.settledKey === key ? (window.settledRun ?? 0) + 1 : 0;
    window.settledKey = key;
    return window.settledRun >= 2 && rect.width > 0;
  })()`;
}

/** Wait for a private native setup transition without repeating its command or weakening an assertion. */
async function phoneSetupState(read, message) {
  const deadline = Date.now() + 20_000; // budget: declared hang ceiling for a private enrollment/approval metadata transition.
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  assert.fail(message);
}

test('a phone with no readable board can tap its pending link and open that board [N26,H5,H17]', chromeOptions, async t => {
  const box = await relayClientFixture(t);
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  // Set the input device before navigation; resizing a page after its desktop startup cannot prove the phone path.
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `const phoneFixtureFetch = window.fetch;
window.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (['http://127.0.0.1:4890', 'http://localhost:4890'].includes(url.origin)) return Promise.reject(new TypeError('No local view in this private phone fixture'));
  return phoneFixtureFetch(input, options);
};` });
  assert.equal((await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  })).success, true, 'only the synthetic fixture session is installed');
  const setup = box.startCli(['relay', 'on', '--all', '--url', box.origin]);
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const pending = await phoneSetupState(() => existsSync(machineFile) && JSON.parse(readFileSync(machineFile, 'utf8')).pending,
    'the native command publishes its one-time phone enrollment');
  await chrome.navigate(box.origin + '/#device=' + pending.locator + '.' + pending.secret);
  const paired = await setup.closed;
  assert.equal(paired.code, 0, 'native setup authenticates this browser and delivers its original board key');
  await chrome.waitFor("document.documentElement.dataset.relayDevice === 'phone' && document.querySelector('#phone-approvals') !== null");

  const publisher = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  // Only the phone cannot read its publisher; keep native setup healthy and preserve each real authorization read.
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `const authorizedPhoneFetch = window.fetch;
window.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const response = await authorizedPhoneFetch(input, options);
  if (${JSON.stringify(['/api/v1/boards/' + publisher + '/state', '/api/v2/boards/' + publisher + '/state'])}.includes(url.pathname) && response.ok) {
    return new Response(JSON.stringify({ version: 1, error: { code: 'NO_SNAPSHOT', message: 'This private phone snapshot is unavailable.' } }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
  }
  return response;
};` });
  box.providerState.repositories.push('phone-first-link');
  const target = join(dirname(box.root), 'phone-first-link');
  mkdirSync(target);
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', 'git@github.com:fixture/phone-first-link.git']]) {
    runFixtureGit(args, { cwd: target, env: box.env, encoding: 'utf8' });
  }
  assert.equal((await box.cliAtLocal(target, 'init')).code, 0, 'the actual new-project init publishes its sealed approval');
  const marker = 'FIRST_READABLE_BOARD_AFTER_ONE_PHONE_TAP_901';
  assert.equal((await box.cliAtLocal(target, 'add', box.lane, marker)).code, 0);
  const proposal = JSON.parse(readFileSync(machineFile, 'utf8')).approvals.find(entry => entry.root === target);
  assert.equal(proposal?.published, true, 'the actual native proposal is waiting for this enrolled browser');
  const selector = '#phone-approve-' + proposal.context.id;
  const beforeForeground = box.calls.length;
  const run = box.startCli(['relay', 'on', '--all', '--url', box.origin], {}, { json: false });
  await phoneSetupState(() => box.calls.slice(beforeForeground).some(call => call.method === 'GET'
    && call.path === '/api/v1/devices/approvals/' + proposal.context.id), 'the same foreground command is actually waiting for this approval');
  await chrome.navigate('about:blank');
  await chrome.navigate(box.origin);
  await chrome.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null && Array.isArray(data?.projects)`);
  await chrome.waitFor(settled(selector));
  const before = await chrome.stable(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    const rect = button.getBoundingClientRect();
    return { phone: document.documentElement.dataset.relayDevice, screen: document.documentElement.dataset.relayScreen,
      listed: data?.projects?.length ?? null, shown: rect.width > 0 && rect.height > 0, cards: document.querySelectorAll('.phone-approval').length };
  })()`);
  console.log(JSON.stringify({ firstPhoneApprovalControl: before }));
  assert.equal(before.phone, 'phone');
  assert.equal(before.listed, 0, 'no readable board can dismiss the first screen');
  assert.equal(run.child.exitCode, null, 'the native foreground command is still waiting for the person');
  assert.equal(before.shown, true, 'the pending native approval must be visible, not merely present under the hidden board shell');
  await chrome.stable(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
  await chrome.waitFor(settled(selector));
  const point = await chrome.stable(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)}); const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    return { x, y, hit: button.contains(document.elementFromPoint(x, y)) };
  })()`);
  assert.equal(point.hit, true, 'the actual input target is the approval button');
  const authorizations = box.calls.filter(call => call.path.endsWith('/authorize')).length;
  await tapTouch(chrome, `document.querySelector(${JSON.stringify(selector)})`);
  const linked = await run.closed;
  assert.equal(linked.code, 0, 'the same foreground command finishes after one real phone tap');
  await chrome.waitFor(`data?.root === ${JSON.stringify(proposal.context.board)} && !!document.querySelector('[data-tab=items]')`);
  await chrome.click("document.querySelector('[data-tab=items]')");
  await chrome.waitFor(`document.body.innerText.includes(${JSON.stringify(marker)}) && data?.root === ${JSON.stringify(proposal.context.board)}`);
  assert.equal(await chrome.stable('document.documentElement.dataset.relayScreen ?? null'), null, 'the readable board replaces the first screen');
  assert.equal(box.calls.filter(call => call.path.endsWith('/authorize')).length - authorizations, 1, 'one tap authorizes exactly once');
});

test('a phone draws its saved board while the approvals read never answers [N26,H5,H17] [clause 1]', chromeOptions, async t => {
  const box = await relayClientFixture(t);
  const marker = 'READABLE_BOARD_WITH_PENDING_REQUESTS_899';
  assert.equal((await box.cliLocal('add', box.lane, marker)).code, 0);
  await box.link();
  const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const cookie = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(cookie.success, true, 'the private fixture session is installed');
  // Private fixture key material is passed only as a CDP argument, never in an assertion or diagnostic label.
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('pullboard.relay.keys.v1', ${JSON.stringify(JSON.stringify({ [board]: encoded }))});
const nativeFetch = window.fetch;
window.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin === 'http://127.0.0.1:4890') return Promise.reject(new TypeError('Fixture has no local view'));
  if (/^\\/api\\/v1\\/devices\\/[^/]+\\/approvals$/.test(url.pathname)) {
    window.approvalsPending899 = true;
    if (window.approvalsRecovered899) return Promise.resolve(new Response(JSON.stringify({ version: 1, approvals: [] }), {
      headers: { 'content-type': 'application/json' },
    }));
    return new Promise(() => {});
  }
  return nativeFetch(input, options);
};`,
  });
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.readyState === 'complete'");
  await chrome.waitFor("!!document.querySelector('[data-tab=items]')");
  await chrome.click("document.querySelector('[data-tab=items]')");
  const panelOwnership = await chrome.stable(`(async () => {
    const { phoneApprovalStatus, placePhoneApprovals, forgetPhoneApprovals } = await import('/relay/browser-approval-card.js');
    const doc = document.implementation.createHTMLDocument('Private approval ownership');
    doc.body.innerHTML = '<main></main>';
    const panel = phoneApprovalStatus(doc, 'Private pending request');
    const button = doc.createElement('button'); let clicks = 0; button.onclick = () => clicks++; panel.append(button);
    doc.querySelector('main').replaceChildren(doc.createElement('section'));
    const restored = placePhoneApprovals(doc); button.dispatchEvent(new MouseEvent('click'));
    const retained = restored === panel && doc.querySelector('main').contains(panel) && clicks === 1;
    forgetPhoneApprovals(doc);
    return { retained, released: panel.childNodes.length === 0 && placePhoneApprovals(doc) === null };
  })()`);
  assert.deepEqual(panelOwnership, { retained: true, released: true }, 'board redraw retains live handlers; access loss releases them');
  // Seed a real non-extractable browser key without exporting it; the authenticated saved board is already readable.
  const seeded = await chrome.stable(`(async () => {
    const { createDeviceKeys } = await import('/relay/device-keys.js');
    const { ENGINE_VERSION } = await import('/relay/engine.js');
    const identity = await (await fetch('/api/v1/devices/session', { headers: { 'x-pullboard-engine': String(ENGINE_VERSION) } })).json();
    const device = { ...await createDeviceKeys(), account: identity.account, locator: 'fixture-899' };
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pullboard-relay-device-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { await new Promise((resolve, reject) => {
      const transaction = db.transaction('keys', 'readwrite'); transaction.objectStore('keys').put(device, 'device');
      transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(transaction.error);
    }); } finally { db.close(); }
    return true;
  })()`);
  assert.equal(seeded, true, 'the synthetic private browser device is retained');
  await chrome.navigate('about:blank');
  await chrome.navigate(box.origin);
  await chrome.waitFor('window.approvalsPending899 === true');
  await chrome.waitFor(`document.querySelector('#chain')?.textContent.includes(${JSON.stringify(marker)}) && document.documentElement.dataset.relayScreen === undefined && document.body.innerText.includes('Checking requests from your computer')`, 3000, // budget: declared #899 three-second ceiling while the late request never answers.
    'readable board and pending guidance render while approvals remain pending');
  assert.equal(await chrome.stable('window.approvalsPending899 === true'), true);
  assert.ok((await chrome.stable('document.body.innerText')).includes(marker));
  assert.ok((await chrome.stable('document.body.innerText')).includes('Checking requests from your computer'),
    'the pending background read has visible guidance alongside the board');
  await chrome.waitFor("document.body.innerText.includes('Requests from your computer did not load')", 20_000, // budget: product fifteen-second I/O ceiling plus five seconds for native fixture scheduling.
    'an uncooperative request still reports its deadline');
  assert.ok((await chrome.stable('document.body.innerText')).includes(marker), 'the board survives the background failure');
  await chrome.stable('window.approvalsRecovered899 = true');
  await chrome.waitFor("!document.querySelector('.phone-approval-status')", 3000, // budget: derived from one-second approvals polling plus two seconds for fixture scheduling.
    'a later successful poll clears the failure guidance');
  assert.ok((await chrome.stable('document.body.innerText')).includes(marker), 'the board survives recovery too');
});

test('a signed-in phone shows its first screen before a local probe can answer [N26,H5,H17]', chromeOptions, async t => {
  const handle = createRelayBrowserHandler({ authenticate: async () => ({ kind: 'session' }) });
  const server = createServer(async (req, res) => {
    if (!await handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.fetch = () => new Promise(() => {});',
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  await chrome.navigate(origin);
  await chrome.waitFor("document.readyState === 'complete' && document.documentElement.dataset.relayDevice === 'phone'");
  const first = await chrome.stable(`({
    screen: document.documentElement.dataset.relayScreen ?? null,
    visible: document.querySelector('#relay-screen h1')?.getClientRects().length > 0,
    text: document.body.innerText,
  })`);
  assert.equal(first.screen, 'share', 'a signed-in phone gets its screen before any asynchronous probe or board read');
  assert.equal(first.visible, true, 'the screen heading is painted, not merely present in hidden markup');
  assert.match(first.text, /Checking your linked boards/u);
  assert.doesNotMatch(first.text, /pullboard relay on --all/u, 'an unanswered inventory offers no sharing command');
});

test('a phone keeps its screen and the reason while a saved board fails or waits [N26,H5,H17]', chromeOptions, async t => {
  let code = 'BAD_SNAPSHOT';
  const handle = createRelayBrowserHandler({ authenticate: async () => ({ kind: 'session' }) });
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) {
      const body = req.url.endsWith('/state') ? { version: 1, error: { code, message: 'Fixture snapshot is unavailable.' } }
        : { version: 1, boards: [{ id: 'a'.repeat(32), repository: 'fixture/project' }], warnings: [] };
      res.writeHead(req.url.endsWith('/state') ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } else if (!await handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('pullboard.relay.keys.v1', JSON.stringify({ ['a'.repeat(32)]: btoa('x'.repeat(32)).replaceAll('=', '') }));
const nativeFetch = window.fetch;
window.fetch = (input, options) => String(input).startsWith('http://127.0.0.1:4890/')
  ? Promise.reject(new TypeError('Fixture has no local view')) : nativeFetch(input, options);`,
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const [failure, expected] of [['BAD_SNAPSHOT', 'Could not open this board'], ['NO_SNAPSHOT', 'waiting for its first snapshot']]) {
    code = failure;
    await chrome.navigate('about:blank');
    await chrome.navigate(origin);
    await chrome.waitFor(`document.querySelector('#relay-notice')?.textContent.includes(${JSON.stringify(expected)})`);
    const shown = await chrome.stable(`({ text: document.body.innerText, screen: document.documentElement.dataset.relayScreen ?? null })`);
    assert.equal(shown.screen, 'share', 'an unreadable saved board cannot dismiss the phone screen');
    assert.ok(shown.text.includes(expected), 'the person can read the actual reason, not just hidden banner markup');
  }
});

test("the relay page opens without a session and may call only the local view's default port [N26,H5,A2]", async t => {
  const box = await relayClientFixture(t);
  const privateTitle = 'PRIVATE_RELAY_BOARD_533';
  assert.equal((await box.cliLocal('add', box.lane, privateTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const privateKey = readFileSync(box.keyFile, 'utf8').trim();
  const response = await fetch(box.origin + '/');
  assert.equal(response.status, 200, 'the public entry does not require a relay session');
  const page = await response.text();
  assert.ok(page.includes('id="chain"'), 'the anonymous response is the cockpit shell');
  for (const privateValue of [privateTitle, link.board, privateKey, link.token]) {
    assert.equal(page.includes(privateValue), false, 'the shell contains no private board or credential value');
  }
  const policy = response.headers.get('content-security-policy');
  const directives = new Map(policy.split(';').map(part => part.trim().split(/\s+/u)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives.get('connect-src'), ["'self'", 'http://127.0.0.1:4890', 'http://localhost:4890'],
    'only the relay itself and the two exact loopback default-port origins can be contacted');
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page, /Sign in with GitHub/u, 'relay mode retains its sign-in path');
});


test('a signed-out relay page keeps sign-in visible without starting relay reads [N26,H5,A2]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const privateTitle = 'PRIVATE_RELAY_BOARD_533_ANONYMOUS';
  assert.equal((await box.cliLocal('add', box.lane, privateTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const privateKey = readFileSync(box.keyFile, 'utf8').trim();
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  await chrome.send('Page.enable', {});
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { sessionStorage.setItem('relayAnonymousDocumentCount', String(Number(sessionStorage.getItem('relayAnonymousDocumentCount') || 0) + 1)); } catch {}",
  });
  const firstCall = box.calls.length;
  await chrome.navigate(box.origin + '/');
  // Budget: six seconds reproduce the reviewed reload loop and span a relay refresh interval.
  await new Promise(resolve => setTimeout(resolve, 6000));
  const calls = box.calls.slice(firstCall);
  assert.equal(calls.filter(call => call.method === 'GET' && call.path === '/').length, 1,
    'the anonymous shell does not reload');
  await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('a[href=\"/auth/github/start\"]')");
  const loads = await chrome.stable("Number(sessionStorage.getItem('relayAnonymousDocumentCount') || 0)");
  const privateValues = [privateTitle, link.board, privateKey, link.token];
  const retained = await chrome.stable(`({ html: document.documentElement.innerHTML,
    local: JSON.stringify(localStorage), session: JSON.stringify(Object.fromEntries(
      Array.from({ length: sessionStorage.length }, (_, index) => {
        const key = sessionStorage.key(index); return [key, sessionStorage.getItem(key)];
      }).filter(([key]) => key !== 'relayAnonymousDocumentCount'))) })`);
  assert.equal(loads, 1, 'the anonymous shell does not reload');
  assert.equal(calls.filter(call => call.method === 'GET' && call.path === '/api/v1/boards').length, 0,
    'the anonymous shell never starts relay board reads');
  assert.equal(await chrome.stable("!!document.querySelector('a[href=\"/auth/github/start\"]')"), true,
    'the original sign-in link remains available');
  assert.equal([retained.html, retained.local, retained.session].some(value => privateValues.some(secret => value.includes(secret))), false,
    'the anonymous page and its browser storage retain no private board or credential value');
});

test('a revoked relay session settles on sign-in without a reload loop [N26,H5,A2]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const privateTitle = 'PRIVATE_RELAY_BOARD_533_REVOKED';
  assert.equal((await box.cliLocal('add', box.lane, privateTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const privateKey = readFileSync(box.keyFile, 'utf8').trim();
  const phone = await box.phoneSession();
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  await chrome.send('Page.enable', {});
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { sessionStorage.setItem('relayRevokedDocumentCount', String(Number(sessionStorage.getItem('relayRevokedDocumentCount') || 0) + 1)); } catch {}",
  });
  const cookie = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: phone.token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(cookie.success, true);
  box.revokeSessionOnNextListing();
  const firstCall = box.calls.length;
  await chrome.navigate(box.origin + '/');
  await chrome.waitFor("document.readyState === 'complete' && !!document.querySelector('a[href=\"/auth/github/start\"]')");
  // Budget: six seconds after reaching sign-in span a relay refresh interval.
  await new Promise(resolve => setTimeout(resolve, 6000));
  const loads = await chrome.stable("Number(sessionStorage.getItem('relayRevokedDocumentCount') || 0)");
  const calls = box.calls.slice(firstCall);
  const privateValues = [privateTitle, link.board, privateKey, link.token, phone.token];
  const retained = await chrome.stable(`({ html: document.documentElement.innerHTML,
    local: JSON.stringify(localStorage), session: JSON.stringify(Object.fromEntries(
      Array.from({ length: sessionStorage.length }, (_, index) => {
        const key = sessionStorage.key(index); return [key, sessionStorage.getItem(key)];
      }).filter(([key]) => key !== 'relayRevokedDocumentCount'))) })`);
  assert.equal(loads, 2, 'one authorization loss leads to one signed-out document');
  assert.equal(calls.filter(call => call.method === 'GET' && call.path === '/').length, 2,
    'the authenticated page redirects once to the signed-out entry');
  assert.equal(calls.filter(call => call.method === 'GET' && call.path === '/api/v1/boards').length, 1,
    'the invalidated session produces no repeated board listings');
  assert.equal(await chrome.stable("!!document.querySelector('a[href=\"/auth/github/start\"]') && !!document.querySelector('#relay-notice')"), true,
    'the signed-out notice and original sign-in link remain visible');
  assert.equal([retained.html, retained.local, retained.session].some(value => privateValues.some(secret => value.includes(secret))), false,
    'the signed-out page and browser storage retain no private board or credential value');
});

test('relay data still needs a session [N26,H5,A2]', async t => {
  const box = await relayClientFixture(t);
  const before = (await box.cliLocal('export')).document.tables;
  const board = 'a'.repeat(32);
  const device = 'device-' + 'b'.repeat(32);
  const locator = 'c'.repeat(22);
  const prefix = '/api/v1/boards/' + board;
  const routes = [
    ['GET', '/api/v1/boards'], ['GET', '/api/v1/events?boards=' + board],
    ['GET', prefix + '/state'], ['PUT', prefix + '/state'], ['DELETE', prefix],
    ['GET', prefix + '/events?after=0'], ['POST', prefix + '/moves'], ['POST', prefix + '/requests'],
    ['GET', prefix + '/code'], ['GET', prefix + '/tokens'], ['POST', prefix + '/tokens'],
    ['GET', prefix + '/items'], ['GET', prefix + '/items/1'], ['GET', prefix + '/shouts/1'],
    ['POST', '/api/v1/pairings/' + board + '/' + locator],
    ['POST', '/api/v1/pairings/' + board + '/' + locator + '/consume'],
    ['GET', '/api/v1/devices/session'], ['POST', '/api/v1/devices/approvals'],
    ['GET', '/api/v1/devices/approvals/approval'],
    ...['authorize', 'complete', 'execute'].map(action => ['POST', '/api/v1/devices/approvals/approval/' + action]),
    ['GET', '/api/v1/devices/' + device + '/approvals'],
    ...['GET', 'POST', 'PUT', 'DELETE'].map(method => [method, '/api/v1/devices/enrollments/' + locator]),
    ['GET', '/api/v1/devices/' + device + '/boards'],
    ['PUT', '/api/v1/devices/' + device + '/boards/' + board],
    ['POST', '/api/v1/devices/' + device], ['DELETE', '/api/v1/devices/' + device],
    ...['session', 'boards'].map(path => ['GET', '/auth/' + path]),
    ['GET', '/auth/tokens?board=' + board],
    ['POST', '/auth/boards/link', { board, repository: 'fixture/project' }],
    ['POST', '/auth/machines', { board, machine: 'fixture-machine' }],
    ['POST', '/auth/tokens', { board, agent: 'fixture-agent' }],
    ['POST', '/auth/tokens/revoke', { id: 'fixture-token-id' }],
  ];
  for (const [method, path, payload] of routes) {
    const response = await fetch(box.origin + path, {
      method,
      headers: { origin: box.origin, 'content-type': 'application/json', 'x-pullboard-engine': String(ENGINE_VERSION),
        ...(path.startsWith('/api/v1/events?') ? { accept: 'text/event-stream' } : {}) },
      ...(['POST', 'PUT'].includes(method) ? { body: JSON.stringify(payload ?? {}) } : {}),
    });
    const document = await response.json();
    assert.equal(response.status, 401, method + ' ' + path + ' refuses before returning data or applying an action');
    assert.equal(document.error?.code, 'AUTH_REQUIRED', method + ' ' + path + ' reaches its authentication boundary');
    for (const field of ['boards', 'state', 'events', 'item', 'shout', 'session', 'tokens', 'wraps', 'approval']) {
      assert.equal(Object.hasOwn(document, field), false, 'an anonymous refusal carries no relay data');
    }
  }
  const after = (await box.cliLocal('export')).document.tables;
  for (const table of ['item', 'event', 'shout', 'verdict']) {
    assert.deepEqual(after[table], before[table], 'anonymous relay calls do not change local board ' + table);
  }
});

test('the actual relay page seals its shout and refuses generic direct moves [H12,H5]', chromeOptions, async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  const cookie = await chrome.send('Network.setCookie', { name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax' });
  assert.equal(cookie.success, true);
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
  await chrome.waitFor('typeof data !== "undefined" && !!data?.project && !!transport');
  const capability = await chrome.stable('({readOnly,requests,snapshot})');
  assert.deepEqual(capability, { readOnly: true, requests: true, snapshot: false });
  const before = (await box.cliLocal('export')).document;
  const callsBefore = box.calls.length;
  const direct = await chrome.stable(`api(boardPath(view.root) + '/moves', {verb:'claim',item:1}).then(() => 'allowed', error => error.message)`);
  assert.match(direct, /read-only view/);
  assert.equal(box.calls.slice(callsBefore).some(call => call.method === 'POST'), false, 'the generic direct move never reaches the relay');
  await chrome.click("document.querySelector('[data-tab=shouts]')");
  await chrome.waitFor("document.querySelector('#shout-form')?.getClientRects().length > 0 && document.querySelector('#shout-text')?.getClientRects().length > 0");
  const composer = await chrome.stable(`(() => {
    const form = document.querySelector('#shout-form'), text = document.querySelector('#shout-text'), send = document.querySelector('#shout-send');
    return { formVisible: form.getClientRects().length > 0, textVisible: text.getClientRects().length > 0,
      sendVisible: send.getClientRects().length > 0, sendEnabled: !send.disabled && !text.disabled };
  })()`);
  assert.deepEqual(composer, { formVisible: true, textVisible: true, sendVisible: true, sendEnabled: true },
    'read-only page provides usable visible shout controls');
  await chrome.stable(`document.querySelector('#shout-to').value='coordinator'; document.querySelector('#shout-text').value='RELAY_PAGE_SEALED_SHOUT'; document.querySelector('#shout-form').requestSubmit(); true`);
  await chrome.waitFor('data.project.personRequests?.some(row => row.move?.args?.text === "RELAY_PAGE_SEALED_SHOUT")');

  const request = await chrome.stable('data.project.personRequests.find(row => row.move?.args?.text === "RELAY_PAGE_SEALED_SHOUT")');
  assert.equal(request.status, 'waiting');
  assert.deepEqual(request.move, { verb: 'shout', args: { to: 'coordinator', text: 'RELAY_PAGE_SEALED_SHOUT' } });
  assert.equal(box.calls.some(call => call.method === 'POST' && call.path === `/api/v1/boards/${link.board}/requests`), true);
  assert.equal(box.calls.slice(callsBefore).some(call => call.method === 'POST' && call.path.endsWith('/moves')), false, 'the page never posts an executable engine move');
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/events?after=0', { headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  assert.equal(response.status, 200);
  const events = await response.json();
  assert.equal(JSON.stringify(events).includes('RELAY_PAGE_SEALED_SHOUT'), false, 'the relay holds ciphertext, not shout text');
  assert.ok(events.events.some(event => event.kind === 'request' && typeof event.sealed === 'string'));
  assert.equal(box.keyInRequest(), false);
  // The browser queued intent; only the next native command may author the shout.
  assert.equal(before.tables.shout.some(row => row.shout_text === 'RELAY_PAGE_SEALED_SHOUT'), false);
  assert.equal((await box.cli('status')).code, 0);
  const after = (await box.cliLocal('export')).document;
  assert.equal(after.tables.shout.filter(row => row.shout_from === 'person' && row.shout_text === 'RELAY_PAGE_SEALED_SHOUT').length, 1);
});

test('an actual exported snapshot and local read-only page refuse all seven person actions [H12,H5]', chromeOptions, async t => {
  const box = await relayClientFixture(t);
  const directory = join(box.root, 'readonly-export');
  assert.equal((await box.cliLocal('view', '--export', directory)).code, 0);
  const readonly = cockpitPage('', { readOnly: true });
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/readonly') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readonly); return; }
    let file = join(directory, path === '/' ? 'index.html' : path.slice(1));
    if ((!existsSync(file) || !statSync(file).isFile()) && existsSync(file + '.json')) file += '.json';
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'text/html' });
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  for (const [path, exported] of [['/', true], ['/readonly', false]]) {
    await chrome.navigate(origin + path);
    await chrome.waitFor('typeof data !== "undefined" && !!data?.project');
    assert.deepEqual(await chrome.stable('({snapshot,requests,readOnly})'), { snapshot: exported, requests: false, readOnly: !exported });
    const refusals = await chrome.stable(`(async () => {
      const actions=[['add',{lane:'web',title:'refused'}],['shout',{to:'coordinator',text:'refused'}],['answer',{id:1,text:'refused'}],['hold',{lane:'web',reason:'refused'}],['release',{lane:'web'}],['spec-approve',{ids:'G1'}],['spec-decline',{ids:'G1',reason:'refused'}]];
      const results=[];
      for(const [command,args] of actions) results.push(await act(command,args));
      return results;
    })()`);
    assert.deepEqual(refusals, Array(7).fill(false), 'all seven handlers refuse without the requests capability');
    assert.match(await chrome.stable(`api(boardPath(view.root)+'/moves',{verb:'shout',args:{to:'coordinator',text:'refused'}}).then(()=>'allowed',error=>error.message)`), /read-only/);
  }
  assert.equal((await box.cliLocal('export')).document.tables.shout.some(row => row.shout_text === 'refused'), false);
});
