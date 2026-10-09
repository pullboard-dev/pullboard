/** Real Chrome reads and follows device-sealed boards; the relay never receives its key [H5,H15,H18]. */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { snapshotState, presentationState } from '../relay/browser-model.js';
import { decodeBoardKey, seal, unseal } from '../src/seal.js';
import { relaySnapshot } from '../src/relay-presentation.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { addItem, closeBoard, openBoard } from '../src/board.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';

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

test('relay fixture relaunches once when Chrome does not publish a DevTools port [H5]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-relay-relaunch-'));
  let chrome;
  t.after(async () => {
    await chrome?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { wrapper, counter } = writeLaunchWrapper(directory, { chrome: findChromeExecutable() });
  await assert.doesNotReject((async () => { chrome = await startChrome({ executable: wrapper }); })(),
    'the fixture retries once after the first launch fails');
  assert.equal(await chrome.evaluate('1 + 1'), 2, 'the second real browser reaches its local DevTools endpoint');
  assert.equal(Number(readFileSync(counter, 'utf8')), 2, 'the wrapper launched once unsuccessfully and once successfully');
});

test('relay fixture keeps the startup refusal after its second failed launch [H5]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-relay-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { wrapper, counter } = writeLaunchWrapper(directory, { failEveryLaunch: true });
  await assert.rejects(startChrome({ executable: wrapper }), /Isolated Chrome exited during startup\./u);
  assert.equal(Number(readFileSync(counter, 'utf8')), 2, 'a second failure does not trigger a third launch');
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

test('relay fixture does not relaunch after Chrome publishes its DevTools port [H5]', async t => {
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
    name: 'pb_session', value: state.token, url: box.origin, httpOnly: true, sameSite: 'Lax',
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
  const document = JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(row.sealed, 'base64url'), { boardId: link.board, kind: 'snapshot', sequence: row.sequence })));
  assert.equal(document.presentation.state.spec.some(rule => rule.text === 'SPEC_PRESENTATION_ONLY_108'), true);
});

test('real Chrome pairs, retains its device key, declares its engine on every relay request and shows inactivity [H5,H15,H18,H16,H3]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const firstTitle = 'SEALED_BROWSER_INITIAL_108';
  const liveTitle = 'SEALED_BROWSER_LIVE_108';
  const secondTitle = 'SECOND_LINKED_BOARD_108';
  assert.equal((await box.cli('add', box.lane, firstTitle)).code, 0);
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
  assert.equal(await chrome.evaluate("getComputedStyle(document.querySelector('#new-item')).display === 'none'"), true, 'the relay page hides action controls');
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


  assert.equal((await box.cli('add', box.lane, liveTitle)).code, 0);
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
  assert.equal((await box.cli('add', box.lane, privateTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const presentation = relaySnapshot(box.root).presentation;
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
  assert.equal((await box.cli('add', box.lane, initialTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.setInterval = () => 0;' });
  await signIn(chrome, box);
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(initialTitle) + ')');
  const presentation = relaySnapshot(box.root).presentation;
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
  const initialTitle = 'LATE_SNAPSHOT_INITIAL_108';
  const finalTitle = 'LATE_SNAPSHOT_REPAIRED_108';
  assert.equal((await box.cli('add', box.lane, initialTitle)).code, 0);
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

  const checkpoint = relaySnapshot(box.root);
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
  assert.equal((await box.cli('add', box.lane, marker)).code, 0);
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

/** A pre-ordered mirror's durable local outbox keeps its final browser projection recoverable. */
test('legacy queued presentations never disclose later unacknowledged moves [H5,H15]', async t => {
  const box = await relayClientFixture(t);
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
  const document = JSON.parse(new TextDecoder().decode(await unseal(key, Buffer.from(checkpoint.sealed, 'base64url'), { boardId: link.board, kind: 'snapshot', sequence: checkpoint.sequence })));
  assert.equal(document.presentation.state.items.some(item => item.title === 'FIRST_QUEUED_108'), true);
  assert.equal(document.presentation.state.items.some(item => item.title === 'SECOND_QUEUED_108'), true);
  const compacted = await fetch(box.origin + '/api/v1/boards/' + link.board + '/events?after=0', { headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  assert.equal(compacted.status, 409, 'the relay compacted the moves only after acknowledging their final checkpoint');
});
