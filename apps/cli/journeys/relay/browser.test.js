// pullboard: browser
/** @pullboard-test-gui */
/** Real Chrome reads and follows device-sealed boards; the relay never receives its key [H5,H15,H18]. */
import {
  nativeBoardPorts as relayPresentationNativePorts,
  openBoard,
} from '../../../lib/index.js';
import assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  snapshotState,
  presentationState,
} from '../../../relay/index.js';
import {
  decodeBoardKey,
  seal,
  unseal,
} from '../../../../packages/kernel/index.js';
import { relaySnapshot } from '../../../../packages/pages/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { openPagedSnapshot } from '../../../../packages/pages/index.js';
import {
  addItem,
  answerDecision,
  closeBoard,
  shout,
} from '../../../../packages/store/index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import {
  findChromeExecutable,
  relayWorkBudgetMs,
  startChrome,
} from '../../tests/fixtures/relay/browser.js';
import {
  pairStudioPhone,
  phoneExpiry,
  readApprovalCard,
  studioCommand,
  studioProject,
} from '../../tests/fixtures/relay/studio.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

/** Read native gzip snapshots while retaining checks against historical uncompressed records. */
function snapshotDocument(plain) {
  return JSON.parse(Buffer.from(plain[0] === 0x1f && plain[1] === 0x8b ? gunzipSync(plain) : plain).toString('utf8'));
}

/** Write an executable that fails its first launch, then optionally delegates to real Chrome. */
function writeLaunchWrapper(directory, { chrome, failEveryLaunch = false, publishPort }) {
  const counter = join(directory, 'launches');
  const wrapper = join(directory, 'chrome-wrapper');
  /** Quote one generated shell argument without interpreting its contents. */
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const retry = failEveryLaunch ? 'exit 23' : chrome ? '[ "$launches" -ne 1 ] || exit 23' : ':';
  const launch = publishPort ? `profile=''
for argument in "$@"; do
  case "$argument" in --user-data-dir=*) profile="\${argument#--user-data-dir=}" ;; esac
done
printf '%s\\n' ${quote(publishPort)} > "$profile/DevToolsActivePort"
sleep 30`
    : chrome ? `exec ${quote(chrome)} "$@"` : 'exit 23';
  const script = `#!/bin/sh
launches=0
if [ -f ${quote(counter)} ]; then launches=$(cat ${quote(counter)}); fi
launches=$((launches + 1))
printf '%s' "$launches" > ${quote(counter)}
${retry}
${launch}
`;
  writeFileSync(wrapper, script);
  chmodSync(wrapper, 0o700);
  return { wrapper, counter };
}

test('relay fixture fails once when Chrome exits during startup [C7]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-relay-relaunch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { wrapper, counter } = writeLaunchWrapper(directory, { chrome: findChromeExecutable() });
  await assert.rejects(startChrome({ executable: wrapper }), /exited during startup/u);
  assert.equal(Number(readFileSync(counter, 'utf8')), 1, 'the relay fixture never retries a failed Chrome launch');
});

test('relay fixture reports its first failed launch [C7]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-relay-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { wrapper, counter } = writeLaunchWrapper(directory, { failEveryLaunch: true });
  await assert.rejects(startChrome({ executable: wrapper }), /exited during startup/u);
  assert.equal(Number(readFileSync(counter, 'utf8')), 1, 'one startup failure means exactly one browser launch');
});

/** Reserve and release an ephemeral loopback port so the wrapper can publish an unavailable endpoint. */
async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  return port;
}

test('relay fixture does not retry after Chrome publishes an unavailable DevTools port [C7]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-relay-target-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { wrapper, counter } = writeLaunchWrapper(directory, { publishPort: await unusedLoopbackPort() });
  await assert.rejects(startChrome({ executable: wrapper }), /Isolated Chrome could not start or connect/u);
  assert.equal(Number(readFileSync(counter, 'utf8')), 1, 'a target connection failure does not retry the launched browser');
});

/** Sign a browser in with the real stand-in device grant, without exposing its credential. */
async function signIn(chrome, box) {
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const result = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(result.success, true, 'the real authorized person session is installed in this private browser');
  return state;
}

test('older native snapshots project into read-only API state and reject wrong board/version [H5,H15]', async t => {
  const box = await relayClientFixture(t);
  const id = box.before.tables.board_meta.find(row => row.meta_key === 'board_id').meta_value;
  const state = snapshotState(box.before, id);
  assert.equal(state.items[0].title, box.before.tables.item[0].item_title);
  assert.equal(Array.isArray(state.products), true);
  const held = structuredClone(box.before);
  held.tables.hold = [{ hold_lane: box.lane, hold_reason: 'fixture hold', hold_by: 'coordinator', hold_at: '2026-01-01T00:00:00.000Z' }];
  Object.assign(held.tables.item[0], { item_status: 'submitted', item_review_by: 'expired-reviewer', item_review_until: '2000-01-01T00:00:00.000Z' });
  const projected = snapshotState(held, id);
  assert.deepEqual(projected.holds, held.tables.hold);
  assert.equal(projected.items[0].reviewer, null);
  assert.throws(() => snapshotState(box.before, '0'.repeat(32)), { code: 'RELAY_SNAPSHOT' });
  assert.throws(() => snapshotState({ ...box.before, version: 2 }, id), { code: 'RELAY_SNAPSHOT' });
  assert.throws(() => presentationState({ version: 2, state }, id), { code: 'RELAY_PRESENTATION' });
});

test('conditional sealed snapshots reauthorize before 304 and refresh spec-only presentation [H5,H15]', async t => {
  const box = await relayClientFixture(t);
  box.legacySnapshotApi(); // This case asserts the historical single-cipher ETag contract.
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const endpoint = box.origin + '/api/v1/boards/' + link.board + '/state';
  const headers = { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) };
  const first = await fetch(endpoint, { headers });
  assert.equal(first.status, 200);
  const tag = first.headers.get('etag');
  assert.equal(typeof tag, 'string');
  const body = await first.json();
  const unchanged = await fetch(endpoint, { headers: { ...headers, 'if-none-match': tag } });
  assert.equal(unchanged.status, 304);
  const unauthorized = await fetch(endpoint, { headers: { 'if-none-match': tag } });
  assert.equal(unauthorized.status, 401, 'a cached ciphertext tag never grants access');
  writeFileSync(join(box.root, 'SPEC.md'), '# Browser fixture spec\n\n## G · Goals\n\n- G1 [draft, must] SPEC_PRESENTATION_ONLY_108 | gate: review\n');
  assert.equal((await box.cli('status')).code, 0, 'a board read publishes changed spec presentation without a move');
  const changed = await fetch(endpoint, { headers: { ...headers, 'if-none-match': tag } });
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get('etag') === tag, false);
  const row = (await changed.json()).state;
  assert.equal(row.sequence, body.state.sequence, 'spec refresh preserves the acknowledged move sequence');
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const document = snapshotDocument(await unseal(key, Buffer.from(row.sealed, 'base64url'), { boardId: link.board, kind: 'snapshot', sequence: row.sequence }));
  assert.equal(document.presentation.state.spec.some(rule => rule.text === 'SPEC_PRESENTATION_ONLY_108'), true);
});

test('real Chrome pairs, retains its device key, declares its engine on every relay request and shows inactivity [H5,H15,H18,H16,H3]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const firstTitle = 'SEALED_BROWSER_INITIAL_108';
  const liveTitle = 'SEALED_BROWSER_LIVE_108';
  const secondTitle = 'SECOND_LINKED_BOARD_108';
  assert.equal((await box.cliLocal('add', box.lane, firstTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  const second = await box.additionalBoard(secondTitle);
  const unauthenticated = await fetch(box.origin + '/');
  const signInPage = await unauthenticated.text();
  assert.equal(signInPage.includes('Sign in with GitHub'), true);
  assert.equal(signInPage.includes(firstTitle), false);
  assert.equal(signInPage.includes(encoded), false);

  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.setInterval = () => 0;',
  });
  await signIn(chrome, box);
  const firstBrowserCall = box.calls.length;
  const beforeUnpaired = box.calls.length;
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes('pair this browser')");
  assert.equal(await chrome.evaluate('document.body.textContent.includes(' + JSON.stringify(firstTitle) + ')'), false);
  assert.equal(box.calls.slice(beforeUnpaired).some(call => /\/(state|events)(?:\?|$)/.test(call.path)), false,
    'a browser without the key sees only authorized board names and pairing guidance');

  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + encoded);
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(firstTitle) + ')');
  assert.equal(await chrome.evaluate('location.hash === ""'), true, 'the pairing key is removed from browser history');
  assert.equal(await chrome.evaluate("JSON.parse(localStorage.getItem('pullboard.relay.keys.v1'))[" + JSON.stringify(link.board) + '].length === 43'), true);
  assert.equal(await chrome.evaluate("getComputedStyle(document.querySelector('#new-item')).display !== 'none' && readOnly && requests"), true, 'the relay page exposes person request controls while keeping direct moves read-only');
  assert.equal(box.calls.some(call => call.accept.includes('text/event-stream')), true, 'the page opened a real authorized event stream');
  const browserApiCalls = box.calls.slice(firstBrowserCall).filter(call => call.path.startsWith('/api/v1/'));
  assert.ok(browserApiCalls.length > 0, 'the browser made authenticated relay API requests');
  assert.ok(browserApiCalls.every(call => call.engine === String(ENGINE_VERSION)), 'every browser API request, including catch-up and the live stream, declares the current engine');
  const browserEngine = await fetch(box.origin + '/relay/engine.js');
  assert.equal(await browserEngine.text(), 'export const ENGINE_VERSION = ' + ENGINE_VERSION + ';\n', 'the served browser engine matches the current relay engine');
  await chrome.navigate(box.origin + '/#board=' + second.id + '&key=' + second.encoded);
  await chrome.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 2");
  assert.equal(await chrome.evaluate("Object.keys(JSON.parse(localStorage.getItem('pullboard.relay.keys.v1'))).length === 2"), true,
    'pairing another board retains both device-only keys');
  const firstSelector = '#proj-list .proj.repo[data-root="' + link.board + '"]';
  await chrome.evaluate('document.querySelector(' + JSON.stringify(firstSelector) + ').click()');
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(firstTitle) + ')');


  assert.equal((await box.cliLocal('add', box.lane, liveTitle)).code, 0);
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(liveTitle) + ')');
  assert.equal(await chrome.evaluate("document.querySelector('#relay-notice').textContent"), '',
    'ordinary native moves do not create a person request or claim that this device has one waiting');
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(liveTitle) + ')');
  assert.equal(await chrome.evaluate('location.hash === ""'), true, 'a later visit needs no new pairing link');
  box.advance(80);
  await chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes('BOARD_INACTIVE') && document.querySelector('#relay-notice').textContent.includes('10 days left')");
  assert.equal(box.keyInRequest(), false, 'the key was never in an HTTP URL or header');
  await box.revokeSession();
  await chrome.waitFor("document.body.textContent.includes('Sign in with GitHub') && !document.body.textContent.includes(" + JSON.stringify(liveTitle) + ')');
});

test('the relay reads an addressed shout [H5,N38]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let shoutId;
  try {
    shoutId = shout(board, { from: 'coordinator', to: 'person', text: 'OLD_ADDRESSED_DECISION_434', lanes: [], decision: true });
    answerDecision(board, shoutId, { agentId: 'coordinator', text: 'Answered on the device', lanes: [], asPerson: true, channel: 'view' });
    for (let index = 0; index < 40; index += 1) {
      shout(board, { from: 'coordinator', to: 'person', text: `RECENT_ADDRESSED_${index}_434`, lanes: [] });
    }
  } finally { closeBoard(board); }
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = readFileSync(box.keyFile, 'utf8').trim();
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await signIn(chrome, box);
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes('pair this browser')");
  const unpaired = await chrome.evaluate(`api('/api/v1/boards/${link.board}/shouts/${shoutId}').then(() => 'unexpected', error => error.message)`);
  assert.match(unpaired, /Pair this browser to read that board/u);

  const pairedBoardExpression = "document.querySelector('#chain')?.textContent.includes('private cleanup fixture item')";
  const captureExpression = `(() => {
    const board = ${JSON.stringify(link.board)};
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (fragment.has('key')) fragment.set('key', '[MASKED]');
    let deviceKeyForBoard = false;
    try {
      const keys = JSON.parse(localStorage.getItem('pullboard.relay.keys.v1') ?? '{}');
      deviceKeyForBoard = typeof keys?.[board] === 'string' && keys[board].length > 0;
    } catch { /* Report only whether a key exists, never the stored value. */ }
    return {
      relayNotice: document.querySelector('#relay-notice')?.textContent ?? null,
      chainFirst200: (document.querySelector('#chain')?.textContent ?? '').slice(0, 200),
      locationHashMasked: location.hash ? '#' + fragment.toString() : '',
      deviceKeyForBoard,
    };
  })()`;
  // Start observing before the hash-only navigation so a stalled pairing leaves its page state in the failure.
  const pairedBoardWait = chrome.waitFor(pairedBoardExpression, relayWorkBudgetMs(), 'the addressed-shout board appears')
    .catch(async error => {
      const capture = {
        relayNotice: null, chainFirst200: null, locationHashMasked: null, deviceKeyForBoard: null,
      };
      try { Object.assign(capture, await chrome.evaluate(captureExpression, 'capture addressed-shout page state', 5000)); }
      catch (captureError) { capture.captureError = captureError.message; }
      const captureText = JSON.stringify(capture);
      const captureContainsPairingKey = captureText.includes(key);
      const safeCapture = captureContainsPairingKey ? captureText.replaceAll(key, '[MASKED]') : captureText;
      const failure = new AssertionError({
        message: `${error.message}\nAddressed-shout page capture: ${safeCapture}\nPairing key present in capture: ${captureContainsPairingKey}`,
        actual: false, expected: true, operator: 'waitFor',
      });
      failure.cause = error;
      throw failure;
    });
  await Promise.all([
    chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + key),
    pairedBoardWait,
  ]);
  const recentState = await chrome.evaluate(`api('/api/v1/boards/${link.board}/state')`);
  assert.equal(recentState.state.shouts.length, 40);
  assert.equal(recentState.state.shouts.some(row => row.shout_id === shoutId), false,
    'the old decision is outside the ordinary recent-40 state window');
  const addressed = await chrome.evaluate(`api('/api/v1/boards/${link.board}/shouts/${shoutId}').then(value => ({ value, error: null }), error => ({ value: null, error: { code: error.code ?? null, message: error.message } }))`);
  assert.equal(addressed.error, null, 'the paired browser resolves the old shout from its local sealed history');
  assert.equal(addressed.value.version, 1);
  assert.equal(addressed.value.shout.shout_id, shoutId);
  assert.equal(addressed.value.shout.shout_text, 'OLD_ADDRESSED_DECISION_434');
  assert.equal(addressed.value.shout.decision_state, 'answered');
  assert.equal(addressed.value.shout.decision_answer.shout_text, 'Answered on the device');
  const invalid = await chrome.evaluate(`api('/api/v1/boards/${link.board}/shouts/0').then(() => 'unexpected', error => error.code)`);
  assert.equal(invalid, 'BAD_REQUEST', 'addressed reads accept only positive integer ids');
  const missing = await chrome.evaluate(`api('/api/v1/boards/${link.board}/shouts/999999').then(() => 'unexpected', error => error.code)`);
  assert.equal(missing, 'NO_SHOUT', 'an absent addressed id has the same named refusal as the local API');
  const write = await chrome.evaluate(`transport.request('/api/v1/boards/${link.board}/shouts/${shoutId}', { text: 'must not leave the device' }).then(() => 'unexpected', error => error.code)`);
  assert.equal(write, 'BAD_REQUEST', 'addressed shout routes remain read-only');
  const unsupported = await chrome.evaluate(`api('/api/v1/boards/${link.board}/code').then(() => 'unexpected', error => error.message)`);
  assert.match(unsupported, /Pair this browser to read that board/u, 'unrelated relay routes remain refused');
  assert.equal(box.calls.some(call => call.path.includes('/shouts/')), false,
    'the browser resolves the complete shout locally from its decrypted sealed presentation');
  assert.equal(box.transit.some(entry => entry.request.includes(Buffer.from('OLD_ADDRESSED_DECISION_434'))), false,
    'the shout text is absent from every request sent to the relay');
  assert.equal(box.keyInRequest(), false, 'the device key and shout plaintext never leave the browser');

  await chrome.navigate(box.origin + '/#shout-' + shoutId);
  const card = `#shout-${shoutId}.found`;
  await chrome.waitFor(`typeof api === 'function' && transport !== null && document.querySelector(${JSON.stringify(card + ' h2')})?.textContent.includes(${JSON.stringify('Shout #' + shoutId)})`);
  assert.equal(await chrome.evaluate(`document.querySelector(${JSON.stringify(card + ' .text')})?.textContent`),
    'OLD_ADDRESSED_DECISION_434', 'the addressed relay fallback opens the actual old shout card');
  assert.equal(await chrome.evaluate("document.querySelector('#shout-address-status') === null"), true,
    'the old-shout fallback does not leave an unavailable-history message');
});

test('a board without a snapshot waits without reloading the page [H5,H16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const healthyTitle = 'NO_BOARD_HEALTHY_BOARD_339';
  const healthyUpdate = 'NO_BOARD_HEALTHY_BOARD_UPDATE_339';
  const missingTitle = 'NO_BOARD_WAITING_BOARD_339';
  const missingEventsTitle = 'NO_BOARD_WAITING_EVENTS_339';
  assert.equal((await box.cliLocal('add', box.lane, healthyTitle)).code, 0);
  await box.link();
  const healthy = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const healthyKey = readFileSync(box.keyFile, 'utf8').trim();
  const waiting = await box.additionalBoard(missingTitle);
  const waitingEvents = await box.additionalBoard(missingEventsTitle);
  box.noBoardOnReads(waiting.id, ['state']);
  box.noBoardOnReads(waitingEvents.id, ['events']);

  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'sessionStorage.setItem("pullboard.test.page-starts", String(Number(sessionStorage.getItem("pullboard.test.page-starts") || 0) + 1)); localStorage.setItem("pullboard.relay.keys.v1", ' +
      JSON.stringify(JSON.stringify({ [healthy.board]: healthyKey, [waiting.id]: waiting.encoded, [waitingEvents.id]: waitingEvents.encoded })) + ');',
  });
  await signIn(chrome, box);
  await chrome.navigate(box.origin);
  const pageStarts = await chrome.evaluate("Number(sessionStorage.getItem('pullboard.test.page-starts'))");
  await chrome.waitFor("(document.querySelector('#relay-notice')?.textContent.includes(" + JSON.stringify(waiting.id.slice(0, 8)) + ") && document.querySelector('#relay-notice')?.textContent.includes(" + JSON.stringify(waitingEvents.id.slice(0, 8)) + ") && document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(healthyTitle) + ")) || Number(sessionStorage.getItem('pullboard.test.page-starts')) > " + pageStarts);
  assert.equal(await chrome.evaluate("document.querySelector('#relay-notice')?.textContent.includes(" + JSON.stringify(waiting.id.slice(0, 8)) + ') ?? false'), true,
    'the notice identifies the board whose first snapshot is missing');
  assert.equal(await chrome.evaluate("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(healthyTitle) + ')'), true,
    'the other linked board still renders its actual snapshot');
  assert.equal(await chrome.evaluate("document.querySelector('#relay-notice')?.textContent.includes(" + JSON.stringify(waitingEvents.id.slice(0, 8)) + ') ?? false'), true,
    'an events endpoint with no board snapshot also gets its own waiting notice');
  const healthySelector = '#proj-list .proj.repo[data-root="' + healthy.board + '"]';
  await chrome.evaluate('document.querySelector(' + JSON.stringify(healthySelector) + ').click()');
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(healthyTitle) + ')');
  assert.equal(box.calls.some(call => call.method === 'GET' && call.path === '/api/v1/boards/' + waiting.id + '/state'), true,
    'the real browser requests the listed board snapshot over HTTP');
  assert.equal(box.calls.some(call => call.method === 'GET' && call.path.startsWith('/api/v1/boards/' + waitingEvents.id + '/events')), true,
    'the real browser requests the other listed board event stream over HTTP');

  assert.equal((await box.cliLocal('add', box.lane, healthyUpdate)).code, 0);
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(healthyUpdate) + ')');

  const pageLoads = () => box.calls.filter(call => call.method === 'GET' && call.path === '/').length;
  const beforeWait = pageLoads();
  await new Promise(resolveWait => setTimeout(resolveWait, 10_000));
  assert.equal(pageLoads(), beforeWait, 'the missing snapshot does not reload the real page during ten seconds');

  const listingsBeforeRevocation = box.calls.filter(call => call.method === 'GET' && call.path === '/api/v1/boards').length;
  box.revokeSessionOnNextListing();
  await chrome.evaluate("location.hash = '#refresh-listing'");
  await chrome.waitFor("document.body.textContent.includes('Sign in with GitHub')");
  assert.ok(box.calls.filter(call => call.method === 'GET' && call.path === '/api/v1/boards').length > listingsBeforeRevocation,
    'a real unauthorized listing still sends the page back to sign in');
});

/** Append an authenticated synthetic sealed move without writing it to the private local board. */
async function appendEngineMove(box, link, key, sequence, engine, presentation) {
  const event = { event_id: sequence, event_kind: 'add', event_by: 'fixture', event_at: new Date().toISOString(), event_detail: '{}' };
  const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify({ version: 1, engine, event, ...(presentation ? { presentation } : {}) })), {
    boardId: link.board, kind: 'move', sequence,
  })).toString('base64url');
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/moves', {
    method: 'POST', headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body: JSON.stringify({ sequence, sealed }),
  });
  assert.equal(response.status, 200, 'the private stand-in accepts the synthetic sealed sequence');
  return response.json();
}

test('real Chrome refuses a newer engine in the initial replay without exposing board contents [H5,H15]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const privateTitle = 'ENGINE_TWO_PRIVATE_108';
  assert.equal((await box.cliLocal('add', box.lane, privateTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const presentation = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS).presentation;
  presentation.state.items[0].title = privateTitle;
  await appendEngineMove(box, link, key, 1, ENGINE_VERSION + 1, presentation);

  const chrome = await startChrome();
  t.after(() => chrome.close());
  await signIn(chrome, box);
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
  await chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes(" + JSON.stringify('This board needs engine ' + (ENGINE_VERSION + 1)) + ")");
  assert.equal(await chrome.evaluate('document.body.textContent.includes(' + JSON.stringify(privateTitle) + ')'), false,
    'an unsupported initial event cannot install its attached presentation');
});

test('real Chrome refuses a newer engine delivered over the live stream [H5,H15]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const initialTitle = 'ENGINE_ONE_INITIAL_108';
  const privateTitle = 'ENGINE_TWO_LIVE_PRIVATE_108';
  assert.equal((await box.cliLocal('add', box.lane, initialTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.setInterval = () => 0;' });
  await signIn(chrome, box);
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(initialTitle) + ')');
  const presentation = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS).presentation;
  presentation.state.items[0].title = privateTitle;
  await appendEngineMove(box, link, key, 1, ENGINE_VERSION + 1, presentation);
  await chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes(" + JSON.stringify('This board needs engine ' + (ENGINE_VERSION + 1)) + ")");
  assert.equal(await chrome.evaluate('document.body.textContent.includes(' + JSON.stringify(privateTitle) + ')'), false,
    'a newer live engine is refused before its presentation changes the page');
});

test('real Chrome waits for and installs the late snapshot that compacts a legacy move [H5,H15]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  box.legacySnapshotApi(); // The stand-in deliberately publishes a historical API1 checkpoint below.
  const initialTitle = 'LATE_SNAPSHOT_INITIAL_108';
  const finalTitle = 'LATE_SNAPSHOT_REPAIRED_108';
  assert.equal((await box.cliLocal('add', box.lane, initialTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.setInterval = () => 0;' });
  await signIn(chrome, box);
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(initialTitle) + ')');

  await appendEngineMove(box, link, key, 1, ENGINE_VERSION);
  await new Promise(resolveLate => setTimeout(resolveLate, 350));
  assert.equal(await chrome.evaluate('document.body.textContent.includes(' + JSON.stringify(finalTitle) + ')'), false,
    'the event position is not consumed while the current snapshot is behind it');

  const checkpoint = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
  checkpoint.tables.item[0].item_title = finalTitle;
  checkpoint.presentation.state.items[0].title = finalTitle;
  const bytes = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(checkpoint)), {
    boardId: link.board, kind: 'snapshot', sequence: 1,
  })).toString('base64url');
  const uploaded = await fetch(box.origin + '/api/v1/boards/' + link.board + '/state', {
    method: 'PUT', headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: 1, sealed: bytes }),
  });
  assert.equal(uploaded.status, 200, 'the stand-in acknowledges a snapshot covering the move');
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(finalTitle) + ')');
  const replay = await fetch(box.origin + '/api/v1/boards/' + link.board + '/events?after=0', { headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  assert.equal(replay.status, 409, 'the relay compacted the covered event and requires the new snapshot cursor');
  assert.equal(box.keyInRequest(), false, 'the key remains absent from browser requests');
});

test('an unauthenticated pairing link stays device-only through sign-in and a wrong key shows no contents [H5,H15]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const marker = 'PRIVATE_BOARD_WITH_PAIRING_108';
  assert.equal((await box.cliLocal('add', box.lane, marker)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + encoded);
  await chrome.waitFor("document.body.textContent.includes('Sign in with GitHub') && location.hash === ''");
  assert.equal(await chrome.evaluate('document.body.textContent.includes(' + JSON.stringify(marker) + ')'), false);
  await chrome.navigate(box.origin + '/auth/github/start');
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(marker) + ')');

  const wrong = await startChrome();
  t.after(() => wrong.close());
  await signIn(wrong, box);
  await wrong.navigate(box.origin + '/#board=' + link.board + '&key=' + 'A'.repeat(43));
  await wrong.waitFor("document.querySelector('#relay-notice')?.textContent.includes('Could not open')");
  assert.equal(await wrong.evaluate('document.body.textContent.includes(' + JSON.stringify(marker) + ')'), false);
  assert.equal(box.keyInRequest(), false);
});

/** Make this browser a 390-wide touch phone, so the page sees a coarse pointer and no hover. */
async function asPhone(chrome) {
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

/** Install the person's real stand-in session cookie without reading any board link. */
async function personCookie(chrome, box) {
  const result = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(result.success, true, 'the real person session is installed in this private browser');
}

/** What a person can read and press on the page now: visible text, actions, sizes and colours. */
const SCREEN_FACTS = `(() => {
  const shown = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const box = selector => { const node = document.querySelector(selector); return node && shown(node) ? Math.round(node.getBoundingClientRect().height) : null; };
  const github = document.querySelector('#relay-screen .relay-github');
  const rgb = github && shown(github) ? getComputedStyle(github).backgroundColor.match(/[0-9.]+/g).slice(0, 3).map(Number) : null;
  return {
    screen: document.documentElement.dataset.relayScreen ?? null,
    text: document.body.innerText,
    actions: [...document.querySelectorAll('a[href], button')].filter(shown).map(node => node.textContent.trim()),
    cards: [...document.querySelectorAll('.card-panel')].filter(shown).length,
    footer: shown(document.querySelector('footer.status')),
    github: box('#relay-screen .relay-github'), githubLight: rgb && (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255,
    command: box('#relay-screen .relay-command'), agent: box('#relay-screen .relay-agent'),
    copies: [...document.querySelectorAll('#relay-screen button')].filter(shown).map(node => node.textContent.trim() + ' ' + Math.round(node.getBoundingClientRect().height)),
    commandFont: document.querySelector('#relay-screen .relay-command code') ? getComputedStyle(document.querySelector('#relay-screen .relay-command code')).fontFamily : null,
  };
})()`;

/** Press a screen's Copy button and return what it put on the clipboard. */
async function copied(chrome, selector) {
  return chrome.evaluate(`(async () => {
    const written = new Promise(resolveCopy => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => resolveCopy(value) } });
    });
    document.querySelector(${JSON.stringify(selector)}).click();
    return written;
  })()`);
}

const THIS_COMPUTER = /this computer|this machine|pullboard view|local view|try again/iu;

test('a phone not signed in sees one GitHub button and nothing about this computer [H17,H5]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const marker = 'PHONE_FIRST_SCREEN_BOARD_757';
  assert.equal((await box.cliLocal('add', box.lane, marker)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  const computer = await startChrome();
  t.after(() => computer.close());
  await computer.navigate(box.origin);
  await computer.waitFor("document.readyState === 'complete' && document.querySelector('#relay-screen') !== null");
  assert.equal(await computer.evaluate('document.documentElement.dataset.relayScreen ?? null'), null, 'a computer keeps the page its own states draw');

  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator.storage, 'persist', { value: async () => false });" });
  await asPhone(chrome);
  const opened = [['directly', box.origin + '/'], ['after a pairing QR', box.origin + '/#device=' + 'A'.repeat(22) + '.' + 'B'.repeat(43)]];
  for (const [how, url] of opened) {
    await chrome.navigate('about:blank'); // A scanned QR opens a new page, never a fragment change in this one.
    await chrome.navigate(url);
    await chrome.waitFor("document.documentElement.dataset.relayScreen === 'sign-in' && location.hash === ''");
    const facts = await chrome.evaluate(SCREEN_FACTS);
    for (const words of ['Your boards, on your phone', 'Sign in with GitHub', 'Nothing to install on your phone.', 'Stuck? On your computer, ask your agent', 'Help me see my boards on my phone.']) {
      assert.equal(facts.text.includes(words), true, how + ': the first screen says ' + words);
    }
    assert.deepEqual(facts.actions, ['Sign in with GitHub', 'Copy'], how + ': one GitHub button, and Copy for the sentence to the agent');
    assert.doesNotMatch(facts.text, THIS_COMPUTER, how + ': nothing about this computer or pullboard view');
    assert.doesNotMatch(facts.text, /\brelay\b|\blinked\b/iu, how + ': no relay or linked words');
    assert.equal(facts.cards, 0, how + ': no empty cards');
    assert.equal(facts.footer, false, how + ': no error footer');
    assert.equal(facts.github, 60, how + ': the GitHub button is 60 px tall');
    assert.deepEqual(facts.copies, ['Copy 60'], how + ': the Stuck line\'s Copy is 60 px tall');
    assert.ok(facts.githubLight < 0.2, how + ': the GitHub button is dark');
    assert.equal(facts.text.trim().endsWith('Copy'), true, how + ': the screen ends with the Stuck line and its Copy');
  }
  assert.equal(await chrome.evaluate("sessionStorage.getItem('pullboard.relay.device-pair.v1') !== null"), true, 'the scanned pairing waits on this phone through sign-in');
  assert.equal(await copied(chrome, '#relay-screen [data-copy]'), 'Help me see my boards on my phone.');
  await chrome.evaluate('sessionStorage.clear()'); // The stand-in code above was never a real pairing.

  await chrome.navigate('about:blank');
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + encoded);
  await chrome.waitFor("document.documentElement.dataset.relayScreen === 'sign-in' && location.hash === ''");
  await chrome.evaluate("document.querySelector('#relay-screen .relay-github').click()");
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(marker) + ") && document.querySelector('#pairing-storage-notice') !== null && document.documentElement.dataset.relayScreen === undefined");
  const board = await chrome.evaluate(`({ text: document.body.innerText, screen: document.documentElement.dataset.relayScreen ?? null,
    after: Boolean(document.querySelector('#chain').compareDocumentPosition(document.querySelector('#pairing-storage-notice')) & Node.DOCUMENT_POSITION_FOLLOWING),
    line: (() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#pairing-storage-notice span')); return range.getClientRects().length; })(),
    lineText: document.querySelector('#pairing-storage-notice').innerText })`);
  assert.equal(board.screen, null, 'the GitHub button leads straight to the board');
  assert.doesNotMatch(board.text, THIS_COMPUTER, 'the paired phone says nothing about this computer or pullboard view');
  assert.equal(board.after, true, 'the board shows before the Home Screen line');
  assert.equal(board.line, 1, 'the Home Screen notice is one line');
  assert.match(board.lineText, /Home Screen/u);
  await chrome.evaluate("document.querySelector('#pairing-storage-notice button').click()");
  assert.equal(await chrome.evaluate("document.querySelector('#pairing-storage-notice') === null"), true, 'the Home Screen line dismisses');
  await chrome.navigate(box.origin + '/');
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(marker) + ')');
  assert.equal(await chrome.evaluate("document.querySelector('#pairing-storage-notice') === null"), true, 'a dismissed line stays dismissed');
});

test('signed in with nothing shared shows one command and waits [H5,H17]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const marker = 'SHARED_WHILE_WAITING_757';
  for (const device of ['a phone', 'another computer']) {
    // Each device starts with no linked boards; the preceding phone iteration really shares its board.
    const box = await relayClientFixture(t);
    assert.equal((await box.cliLocal('add', box.lane, marker)).code, 0);
    const chrome = await startChrome();
    t.after(() => chrome.close());
    if (device === 'a phone') await asPhone(chrome);
    await personCookie(chrome, box);
    await chrome.navigate(box.origin);
    await chrome.waitFor("document.documentElement.dataset.relayScreen === 'share' && document.querySelector('#relay-screen .relay-command button')?.dataset.copy === 'pullboard relay on --all'");
    const facts = await chrome.evaluate(SCREEN_FACTS);
    for (const words of ['One step on your computer', 'pullboard relay on --all', 'Ask your agent', 'Help me share my boards with my phone.', 'Waiting for your boards']) {
      assert.equal(facts.text.includes(words), true, device + ': the screen says ' + words);
    }
    assert.deepEqual(facts.actions, ['Copy', 'Copy'], device + ': Copy for the command and Copy for the agent sentence, and nothing to retry');
    assert.doesNotMatch(facts.text.replace('pullboard relay on --all', ''), /\brelay\b|local view|try again/iu, device + ': relay only inside the command');
    assert.equal(facts.command, 60, device + ': the command box is 60 px tall');
    assert.equal(facts.agent, 60, device + ': the agent box is the same height');
    assert.deepEqual(facts.copies, ['Copy 60', 'Copy 60'], device + ': the command\'s Copy and the agent\'s Copy are 60 px tall');
    assert.match(facts.commandFont, /mono|Menlo|Consolas/iu, device + ': the command is in a mono box');
    if (device === 'a phone') {
      assert.doesNotMatch(facts.text, THIS_COMPUTER, 'the phone says nothing about this computer or pullboard view');
      assert.equal(await copied(chrome, '#relay-screen .relay-command button'), 'pullboard relay on --all');
      assert.equal(await copied(chrome, '#relay-screen .relay-agent button'), 'Help me share my boards with my phone.');
      await chrome.evaluate('window.samePage757 = true');
      await box.link();
      const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
      const encoded = readFileSync(box.keyFile, 'utf8').trim();
      // The person scans the QR into a second tab of the same phone browser; this tab is never touched.
      const tab = await chrome.send('Target.createTarget', { url: box.origin + '/#board=' + link.board + '&key=' + encoded });
      assert.equal(typeof tab.targetId, 'string');
      await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(marker) + ')');
      assert.equal(await chrome.evaluate("window.samePage757 === true && (document.documentElement.dataset.relayScreen ?? null) === null"), true,
        'the waiting page fills in by itself, with no click and no reload');
    }
  }
});

test('a signed-in phone waits for its first listing before prescribing a command [H5,H17]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const marker = 'SHARED_AFTER_SLOW_LISTING_757';
  assert.equal((await box.cliLocal('add', box.lane, marker)).code, 0);
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await asPhone(chrome);
  // Hold every board listing on the network until the test lets it go, as a slow phone connection does.
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const original = window.fetch.bind(window);
    window.held757 = [];
    window.fetch = (input, init) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path !== '/api/v1/boards' || window.release757) return original(input, init);
      return new Promise(resolve => { window.held757.push(() => resolve(original(input, init))); });
    };
    window.releaseListings757 = () => { window.release757 = true; for (const go of window.held757.splice(0)) go(); };
  })();` });
  await personCookie(chrome, box);
  await chrome.navigate(box.origin);
  await chrome.waitFor("window.held757?.length > 0 && document.documentElement.dataset.relayScreen === 'share'");
  const facts = await chrome.evaluate(SCREEN_FACTS);
  assert.equal(await chrome.evaluate('window.release757 === undefined && window.held757.length > 0'), true, 'the first listing is still on its way');
  for (const words of ['Checking your linked boards', 'Checking your boards']) {
    assert.equal(facts.text.includes(words), true, 'while the listing waits, the screen says ' + words);
  }
  assert.doesNotMatch(facts.text, /Pairing this browser|Projects/u, 'no pairing notice or project list while the listing waits');
  assert.equal(facts.text.includes('pullboard relay on --all'), false, 'a pending listing does not prove there are no linked boards');
  await chrome.evaluate('window.samePage757 = true; window.releaseListings757()');
  await chrome.waitFor("document.querySelector('#relay-notice') !== null && document.documentElement.dataset.relayScreen === 'share'");
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  const tab = await chrome.send('Target.createTarget', { url: box.origin + '/#board=' + link.board + '&key=' + encoded });
  assert.equal(typeof tab.targetId, 'string');
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(marker) + ')');
  assert.equal(await chrome.evaluate("window.samePage757 === true && (document.documentElement.dataset.relayScreen ?? null) === null"), true,
    'once a board is shared the waiting page fills in by itself');
});

/** A pre-ordered mirror's durable local outbox keeps its final browser projection recoverable. */
test('legacy queued presentations never disclose later unacknowledged moves [H5,H15]', async t => {
  const box = await relayClientFixture(t);
  box.legacySnapshotApi(); // Its refused write and queued-link metadata belong to the legacy protocol.
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  // Recreate the historical pre-161 link metadata, then commit two local-first rows directly.
  link.cursor = box.before.tables.event.at(-1)?.event_id ?? 0;
  delete link.mode;
  delete link.presentationDigest;
  writeFileSync(box.linkFile, JSON.stringify(link) + '\n', { mode: 0o600 });
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    addItem(board, { by: 'coordinator', lane: box.lane, title: 'FIRST_QUEUED_108' });
    addItem(board, { by: 'coordinator', lane: box.lane, title: 'SECOND_QUEUED_108' });
  } finally { closeBoard(board); }
  box.refuseSnapshotWrites(true);
  const status = await box.cli('status');
  assert.equal(status.code, 0);
  assert.equal((status.document.diagnostics ?? []).some(line => line.includes('[RELAY_UNAVAILABLE]')), true,
    'a refused snapshot keeps the final projection pending for retry');
  assert.equal(box.calls.filter(call => call.method === 'POST' && /\/moves$/.test(call.path)).length, 2, 'both queued moves reached the real stand-in route');
  assert.equal(box.moveAcks.length, 2, 'both encrypted move acknowledgements were captured before snapshot compaction');
  const pendingLink = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(pendingLink.needsPresentation, true);
  assert.equal(Boolean(pendingLink.snapshot), true);
  const oldState = await fetch(box.origin + '/api/v1/boards/' + link.board + '/state', { headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  assert.equal((await oldState.json()).state.sequence, 0, 'the relay did not acknowledge the refused checkpoint');

  box.refuseSnapshotWrites(false);
  const retried = await box.cli('status');
  assert.equal(retried.code, 0);
  assert.equal(retried.document.diagnostics?.length ?? 0, 0, 'the saved checkpoint retries without re-sending acknowledged moves');
  assert.equal(box.moveAcks.length, 2);
  const completedLink = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.equal(completedLink.needsPresentation, false, 'only a matching snapshot acknowledgement clears the pending presentation');
  assert.equal(Boolean(completedLink.snapshot), false);
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const moves = await Promise.all(box.moveAcks.map(async row => JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(row.sealed, 'base64url'), { boardId: link.board, kind: row.kind, sequence: row.event_id })))));
  assert.equal(moves[0].presentation, undefined, 'the earlier record cannot attest the already-advanced whole board');
  assert.equal(moves[1].presentation.state.events[0].event_id, moves[1].event.event_id);
  assert.equal(moves[1].presentation.state.items.some(item => item.title === 'SECOND_QUEUED_108'), true);
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/state', { headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  assert.equal(response.status, 200);
  const checkpoint = (await response.json()).state;
  assert.equal(checkpoint.sequence, box.moveAcks[1].event_id, 'the acknowledged final checkpoint covers the omitted presentation');
  const document = snapshotDocument(await unseal(key, Buffer.from(checkpoint.sealed, 'base64url'), { boardId: link.board, kind: 'snapshot', sequence: checkpoint.sequence }));
  assert.equal(document.presentation.state.items.some(item => item.title === 'FIRST_QUEUED_108'), true);
  assert.equal(document.presentation.state.items.some(item => item.title === 'SECOND_QUEUED_108'), true);
  const compacted = await fetch(box.origin + '/api/v1/boards/' + link.board + '/events?after=0', { headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  assert.equal(compacted.status, 409, 'the relay compacted the moves only after acknowledging their final checkpoint');
});

/** Wait for a genuine native enrollment/approval to reach the fixture, without retrying a move. */
async function browserDeviceTransition(read, message) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolveTransition => setTimeout(resolveTransition, 25));
  }
  assert.fail(message);
}

/** Pair a real Chrome private key through the foreground Mac and its one-use enrollment. */
async function enrolledBrowser(box, t) {
  const setup = box.startCli(['relay', 'on', '--all', '--url', box.origin]);
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const pending = await browserDeviceTransition(() => existsSync(machineFile)
    && JSON.parse(readFileSync(machineFile, 'utf8')).pending, 'the Mac publishes the real phone enrollment');
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await signIn(chrome, box);
  await chrome.navigate(box.origin + '/#device=' + pending.locator + '.' + pending.secret);
  const result = await setup.closed;
  assert.equal(result.code, 0, 'the genuine native phone enrollment succeeds');
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes('private cleanup fixture item') && document.querySelector('#phone-approvals') !== null");
  const state = JSON.parse(readFileSync(machineFile, 'utf8'));
  assert.equal(state.devices.length, 1);
  return { chrome, device: state.devices[0].deviceId };
}

/** Revoke the only enrolled browser through main's fresh provider sign-in, without its own approval. */
async function revokeBrowser(box, _chrome, device) {
  const before = box.calls.length;
  const authorized = box.providerState.deviceAuthorized;
  box.providerState.deviceAuthorized = false;
  try {
    const revoke = box.startCli(['relay', 'revoke', device]);
    await revoke.waitForOutput('Sign in with GitHub: open ');
    assert.ok(box.calls.slice(before).some(record => record.path === '/auth/device/start'),
      'the only phone is removed through a fresh provider sign-in');
    // The page may read pending approvals (#985); approving is the POST.
    assert.equal(box.calls.slice(before).some(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals'), false,
      'the target browser never approves its own removal');
    box.providerState.deviceAuthorized = true;
    const result = await revoke.closed;
    assert.equal(result.code, 0, 'a genuine fresh sign-in completes native revocation');
    assert.equal(JSON.parse(result.stdout).revoked, true);
  } finally { box.providerState.deviceAuthorized = authorized; }
}

test('a revoked device read is refused as revoked [H5,E16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, device } = await enrolledBrowser(box, t);
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const session = await box.phoneSession();
  const headers = { cookie: 'pb_session=' + session.token, 'x-pullboard-engine': String(ENGINE_VERSION) };
  const endpoint = box.origin + '/api/v2/boards/' + link.board + '/state';
  assert.equal((await fetch(endpoint, { headers })).status, 200, 'the genuine enrolled browser can read before revocation');
  await revokeBrowser(box, chrome, device);
  await box.restartRelay();
  const response = await fetch(endpoint, { headers });
  const document = await response.json();
  assert.equal(document.error?.code, 'DEVICE_REVOKED', 'the same browser session cannot keep reading ciphertext after device revocation and relay restart');
  assert.equal(response.ok, false);
  assert.equal('state' in document, false);
  const machine = await fetch(endpoint, { headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  assert.equal(machine.status, 200, 'revoking this browser does not revoke the linked computer');
});

test('a revoked browser shows it was removed and no board [H5,E16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, device } = await enrolledBrowser(box, t);
  const key = 'pullboard.relay.keys.v1';
  assert.equal(await chrome.evaluate(`Object.keys(JSON.parse(localStorage.getItem(${JSON.stringify(key)}))).length > 0`), true);
  await revokeBrowser(box, chrome, device);
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.body.textContent.includes('This browser was removed') || document.querySelector('#chain')?.textContent.includes('private cleanup fixture item')");
  assert.equal(await chrome.evaluate("document.body.textContent.includes('This browser was removed')"), true, 'reload distinguishes a removed browser from an unpaired browser');
  assert.equal(await chrome.evaluate("document.body.textContent.includes('private cleanup fixture item')"), false, 'the old decrypted board is not drawn');
  assert.equal(await chrome.evaluate(`localStorage.getItem(${JSON.stringify(key)}) === null`), true, 'the cached board keys are erased');
  assert.equal(await chrome.evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('pullboard-relay-device-v1', 1);
    open.onsuccess = () => { const db = open.result; const request = db.transaction('keys').objectStore('keys').get('device');
      request.onsuccess = () => { db.close(); resolve(request.result === undefined); }; request.onerror = () => reject(request.error); };
    open.onerror = () => reject(open.error);
  })`), true, 'the removed browser no longer retains its private device key');
  assert.equal(await chrome.evaluate("Object.keys(localStorage).some(key => key.startsWith('pullboard.relay.requests.v1.') || key.startsWith('pullboard.relay.owned-requests.v1.'))"), false, 'cached board request state is erased');
  assert.equal(box.keyInRequest(), false);
});


test('revocation clears an already open browser and its cached board request state [H5,E16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, device } = await enrolledBrowser(box, t);
  const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  assert.equal(await chrome.evaluate("(window.__removedBoardReference = data.project).items.some(item => item.title === 'private cleanup fixture item')"), true);
  await chrome.waitFor('data.project?.historyProgress?.complete === true');
  assert.equal(await chrome.evaluate('window.__removedBoardReference.items === data.project.items'), true,
    'completed background history retains the shared item collection already held by the cockpit');
  // These are device-local opaque caches, never authority or a relay response. Use the real key/sealer.
  await chrome.evaluate(`(async () => {
    const module = await import('/relay/seal.js');
    const board = ${JSON.stringify(board)};
    const key = module.decodeBoardKey(JSON.parse(localStorage.getItem('pullboard.relay.keys.v1'))[board]);
    const sealed = await module.seal(key, new TextEncoder().encode('removed cached request'), {boardId:board,kind:'request',sequence:1});
    let binary = ''; for (const value of sealed) binary += String.fromCharCode(value);
    localStorage.setItem('pullboard.relay.requests.v1.'+board+'.cached', JSON.stringify({id:'cached',sequence:1,sealed:btoa(binary)}));
    localStorage.setItem('pullboard.relay.owned-requests.v1.'+board, JSON.stringify(['cached']));
    return true;
  })()`);
  assert.equal(await chrome.evaluate("Object.keys(localStorage).filter(key => key.startsWith('pullboard.relay.requests.v1.') || key.startsWith('pullboard.relay.owned-requests.v1.')).length"), 2);
  await revokeBrowser(box, chrome, device);
  await chrome.waitFor("document.body.textContent.includes('This browser was removed')");
  assert.equal(await chrome.evaluate("document.body.textContent.includes('private cleanup fixture item')"), false, 'live authorization loss clears the actual drawn board before reload');
  assert.equal(await chrome.evaluate("window.__removedBoardReference.items?.length ?? 0"), 0, 'the shared cached board projection held by the cockpit is cleared, not only its DOM');
  assert.equal(await chrome.evaluate("Object.keys(localStorage).some(key => key.startsWith('pullboard.relay.requests.v1.') || key.startsWith('pullboard.relay.owned-requests.v1.'))"), false, 'non-empty opaque board request caches are erased');
  assert.equal(await chrome.evaluate("document.querySelector('#phone-approvals') === null"), true, 'removed browser releases its approval panel and polling loop');
  assert.equal(await chrome.evaluate("document.querySelector('#relay-removed a')?.getAttribute('href')"), '/auth/github/start');
});

/** Independently probe real public auth delegation after a genuinely enrolled browser is revoked. */
test('reviewer: a revoked bound session cannot regain ciphertext through auth machine minting [H5,E16]', {
 skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
 const box = await relayClientFixture(t);
 const {chrome, device} = await enrolledBrowser(box, t);
 const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
 const oldSession = await box.phoneSession();
 const retainedKey = await chrome.evaluate(`JSON.parse(localStorage.getItem('pullboard.relay.keys.v1'))[${JSON.stringify(link.board)}]`);
 assert.equal(typeof retainedKey, 'string', 'the genuinely enrolled browser already received this board key');
 const endpoint = box.origin + '/api/v2/boards/' + link.board + '/state';
 const oldHeaders = {authorization:'Bearer '+oldSession.token,'x-pullboard-engine':String(ENGINE_VERSION)};
 assert.equal((await fetch(endpoint,{headers:oldHeaders})).status,200,'the bound session has original read access');
 await revokeBrowser(box, chrome, device);
 const refused = await fetch(endpoint,{headers:oldHeaders});
 assert.equal(refused.status,403,'the direct bound-session read is refused');
 assert.equal((await refused.json()).error.code,'DEVICE_REVOKED','revocation is real, not an expired or foreign session');
 // A genuinely fresh unbound GitHub sign-in must remain eligible for lost-phone recovery (#755).
 const start = await fetch(box.origin+'/auth/github/start',{redirect:'manual'});
 const binding=start.headers.getSetCookie().find(value=>value.startsWith('pb_oauth_binding=')).split(';')[0];
 const approved=await fetch(start.headers.get('location'),{redirect:'manual'});
 const callback=await fetch(approved.headers.get('location'),{redirect:'manual',headers:{cookie:binding}});
 assert.equal(callback.status,303,'a fresh independent OAuth sign-in completes');
 const fresh=callback.headers.getSetCookie().find(value=>value.startsWith('pb_session=')).split(';')[0].slice('pb_session='.length);
 assert.notEqual(fresh,oldSession.token,'the positive control really uses a different fresh session');
 const freshRead=await fetch(endpoint,{headers:{authorization:'Bearer '+fresh,'x-pullboard-engine':String(ENGINE_VERSION)}});
 assert.equal(freshRead.status,200,'fresh unbound person recovery remains eligible');
 const minted=await fetch(box.origin+'/auth/machines',{method:'POST',headers:{...oldHeaders,'content-type':'application/json'},body:JSON.stringify({board:link.board,machine:'revoked-browser-redelegation'})});
 const document=await minted.json();
 let delegatedStatus=null,decryptedOriginal=false;
 if(minted.status===201){
   assert.match(document.token,/^pm_[A-Za-z0-9_-]{43}$/u,'the actual auth endpoint issued a machine delegate');
   const delegated=await fetch(endpoint,{headers:{authorization:'Bearer '+document.token,'x-pullboard-engine':String(ENGINE_VERSION)}});
   delegatedStatus=delegated.status;
   if(delegated.status===200){
     const {state}=await delegated.json();
     const page=await openPagedSnapshot(state.root,{
       key:decodeBoardKey(retainedKey),boardId:link.board,sequence:state.sequence,
       /** Prove any wrongly delegated access reaches the real pinned ciphertext graph with that new credential. */
       async get(id,parents){
         const response=await fetch(box.origin+'/api/v2/boards/'+link.board+'/objects/'+id+'?pin='+encodeURIComponent(state.read.id)+'&via='+parents.join(','),{
           headers:{authorization:'Bearer '+document.token,'x-pullboard-engine':String(ENGINE_VERSION)},
         });
         assert.equal(response.status,200);
         const value=await response.json();
         return Uint8Array.from(Buffer.from(value.page.sealed,'base64url'));
       },
     },{maxEngine:ENGINE_VERSION});
     const snapshot=await page.native();
     decryptedOriginal=JSON.stringify(snapshot).includes('private cleanup fixture item');
     assert.equal(decryptedOriginal,true,'the previously received browser key decrypts the regained board');
   }
 }
 t.diagnostic(JSON.stringify({oldBoundRead:refused.status,freshUnboundRead:freshRead.status,machineMint:minted.status,delegatedRead:delegatedStatus,decryptedOriginal}));
 assert.equal(minted.status,403,'a revoked bound browser session must not mint a fresh machine credential that bypasses its revoked read');
 assert.equal(document.error?.code,'DEVICE_REVOKED');
});
/** The revoked session cannot exchange its refusal for another credential through the auth router. */
test('a revoked browser cannot mint or list relay credentials [H5,E16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, device } = await enrolledBrowser(box, t);
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const session = await box.phoneSession();
  const old = { authorization: 'Bearer ' + session.token };
  const paths = ['/auth/session', '/auth/boards', '/auth/machines?board=' + link.board, '/auth/tokens?board=' + link.board];
  for (const path of paths) {
    const response = await fetch(box.origin + path, { headers: old });
    assert.equal(response.status, 200, 'the active enrolled session can read ' + path);
    await response.body?.cancel();
  }
  await revokeBrowser(box, chrome, device);
  await box.restartRelay();
  for (const headers of [old, { cookie: 'pb_session=' + session.token, origin: box.origin }]) {
    for (const path of paths) {
      const response = await fetch(box.origin + path, { headers });
      assert.equal(response.status, 403, 'the revoked session cannot read ' + path);
      assert.equal((await response.json()).error.code, 'DEVICE_REVOKED');
    }
    for (const [path, input] of [
      ['/auth/tokens', { board: link.board, agent: 'revoked-auth-route-probe' }],
      ['/auth/machines', { board: link.board, machine: 'revoked-auth-route-probe' }],
    ]) {
      const response = await fetch(box.origin + path, { method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const document = await response.json();
      assert.equal(response.status, 403, 'the revoked session cannot mint through ' + path);
      assert.equal(document.error?.code, 'DEVICE_REVOKED');
      assert.equal(Object.hasOwn(document, 'token'), false, 'a refusal contains no delegated credential');
    }
  }
});

test('the link approval card names the computer and the board [H17,H5]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, machineFile } = await pairStudioPhone(t, box);
  const notes = await studioProject(box, 'notes');
  const proposal = JSON.parse(readFileSync(machineFile, 'utf8')).approvals.find(entry => entry.root === notes);
  assert.ok(proposal?.published, 'registering notes on studio publishes one link request to the phone');
  await chrome.navigate(box.origin);
  await chrome.waitFor(`document.querySelector('.phone-approval[data-request="${proposal.context.id}"] button') !== null`);
  const card = await readApprovalCard(chrome, proposal.context.id);
  assert.match(card.title, /^Link notes from studio\?$/u, 'the card asks in words which computer links which board');
  assert.equal(card.text.includes('fixture/repository'), true, 'the card names the repository being linked');
  assert.equal(card.text.includes('expires ' + phoneExpiry(proposal.context.expires)), true, 'the expiry is in the phone\'s local time');
  assert.equal(card.text.includes(new Date(proposal.context.expires).toISOString()), false, 'no UTC timestamp on the card');
  assert.doesNotMatch(card.text, /[0-9a-f]{32}/u, 'no raw 32-hex board id on the card');
  assert.equal(card.text.includes(proposal.context.machine) || /machine-/u.test(card.text), false, 'no machine id on the card');
  assert.ok(card.pad.every(value => value > 0), 'the card has padding on every side');
  assert.equal(card.inside, true, 'every line of the card\'s text sits inside its padding');
  assert.equal(card.action, 'Link project');
});

test('the delete card names the board and confirms the delete [H17,H5]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const notes = await studioProject(box, 'notes');
  const { chrome } = await pairStudioPhone(t, box);
  await chrome.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 2");
  const board = JSON.parse(readFileSync(join(notes, '.git/pullboard/relay.json'), 'utf8')).board;
  const off = await studioCommand(box, notes, ['relay', 'off']).done;
  assert.equal(off.code, 0, 'relay off on studio removes the local link and asks the phone');
  const posted = box.transit.findLast(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals');
  const context = JSON.parse(posted.request.toString('utf8')).context;
  assert.equal(context.action, 'delete-board');
  assert.equal(context.board, board);
  const selector = `.phone-approval[data-request="${context.id}"]`;
  await chrome.waitFor(`document.querySelector('${selector} button') !== null`);
  const card = await readApprovalCard(chrome, context.id);
  assert.match(card.title, /^Delete notes from the relay\?$/u, 'the delete card names the board');
  assert.equal(card.text.includes('studio'), true, 'the delete card names the computer that asked');
  assert.doesNotMatch(card.text, /[0-9a-f]{32}/u, 'no raw board id on the delete card');
  assert.equal(card.inside, true, 'the delete card keeps its text inside its padding');
  assert.equal(card.action, 'Delete relay copy');
  await chrome.evaluate(`document.querySelector('${selector} button').click()`);
  await chrome.waitFor("[...document.querySelectorAll('#phone-approvals [role=status]')].some(node => node.textContent === 'notes was deleted from the relay.')");
  const phone = await box.phoneSession();
  const boards = await (await fetch(box.origin + '/auth/boards', { headers: { cookie: 'pb_session=' + phone.token } })).json();
  assert.equal(boards.boards.some(entry => entry.id === board), false, 'the confirmation follows the relay deleting the board');
  await chrome.evaluate(`(() => {
    const original = window.fetch.bind(window);
    window.__approvalLists = 0;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (new URL(typeof input === 'string' ? input : input.url, location.href).pathname.endsWith('/approvals')) window.__approvalLists += 1;
      return response;
    };
  })()`);
  await chrome.waitFor('window.__approvalLists >= 2');
  assert.equal(await chrome.evaluate(`document.querySelector('${selector}') === null && [...document.querySelectorAll('#phone-approvals [role=status]')]
    .some(node => node.textContent === 'notes was deleted from the relay.')`), true, 'the tapped card is gone and its confirmation stays after the next refresh');
});
