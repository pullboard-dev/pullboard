// pullboard: browser
/** @pullboard-test-gui */
/** Recover a native checkpoint timeout through the actual relay page [H16]. The timeout is an API1 checkpoint PUT, so
 * the case runs on the legacy wire (#903). */
import {
  nativeBoardPorts as relayPresentationNativePorts,
  openBoard,
} from '../../../../lib/index.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeBoard } from '../../../../../packages/store/index.js';
import {
  prepareEngineMove,
  applyRelayMove,
} from '../../../../../packages/state/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';
import { relaySnapshot } from '../../../../../packages/pages/index.js';
import {
  decodeBoardKey,
  generateBoardKey,
  seal,
} from '../../../../../packages/kernel/index.js';
import { legacyRelayClientFixture as relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import {
  findChromeExecutable,
  startChrome,
} from '../../../tests/fixtures/relay/browser.js';

/** Bind the real canonical presentation providers once for this fixture module. */
const RELAY_PRESENTATION_PORTS = relayPresentationNativePorts().presentation;

/** Seal a real native document for an exact authenticated relay position. */
async function encoded(key, value, board, kind, sequence) {
  return Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(value)),
    { boardId: board, kind, sequence })).toString('base64url');
}

/** Upload to the real private relay, checking its actual acknowledgement. */
async function upload(box, link, endpoint, sequence, sealed) {
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/' + endpoint, {
    method: endpoint === 'state' ? 'PUT' : 'POST',
    headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body: JSON.stringify({ sequence, sealed }),
  });
  assert.equal(response.status, 200, 'the real authorized relay acknowledges the sealed position');
  return response.json();
}

/** Read the real page transport without holding a long CDP evaluation open. */
async function readState(chrome, board) {
  const task = await chrome.startTask('transport.request(' + JSON.stringify('/api/v1/boards/' + board + '/state') + ')',
    'read recovered native state');
  return chrome.pollTask(task, 45_000, 'read recovered native state');
}

test('a delayed native checkpoint recovers the real page after its visible timeout [H16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const initial = 'RECOVERY_INITIAL_336';
  const recovered = 'RECOVERY_CHECKPOINT_336';
  const later = 'RECOVERY_LATER_NATIVE_336';
  assert.equal((await box.cli('add', box.lane, initial)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encodedKey = readFileSync(box.keyFile, 'utf8').trim();
  const key = decodeBoardKey(encodedKey);
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const cookie = await chrome.send('Network.setCookie', { name: 'pb_session', value: (await box.phoneSession()).token,
    url: box.origin, httpOnly: true, sameSite: 'Lax' });
  assert.equal(cookie.success, true);
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + encodedKey);
  try {
  await chrome.waitFor('typeof transport !== "undefined" && !!transport && document.querySelector("#chain")?.textContent.includes(' + JSON.stringify(initial) + ')');
  } catch (error) { throw new Error(error.message + ' PROBE ' + JSON.stringify(await chrome.evaluate('({url: location.href.slice(0,60), transport: typeof transport, chain: document.querySelector("#chain")?.textContent.slice(0,200), body: document.body.innerText.slice(0,400), notice: document.querySelector("#relay-notice")?.textContent, items: data?.items?.length, root: data?.root, vstate: view?.state, vtab: view?.tab, vlane: view?.lane, keys: Object.keys(data||{}).slice(0,12)})') + ' CALLS ' + JSON.stringify(box.calls.slice(-14).map(c => [c.method, c.path, c.status])) + ' STATE ' + JSON.stringify(await readState(chrome, link.board).then(r => JSON.stringify(r).slice(0, 300), e => 'ERR ' + (e.code || e.message)))), { cause: error }); }
  /** Count real document loads to detect a hidden recovery reload. */
  const pageLoads = () => box.calls.filter(call => call.method === 'GET' && call.path === '/').length;
  /** Count real authorized SSE connections, independently of the page polling timer. */
  const streams = () => box.calls.filter(call => call.method === 'GET' && call.accept.includes('text/event-stream')).length;
  const originalLoads = pageLoads();

  // A real engine operation intentionally has no attached presentation: the native checkpoint is late.
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let move;
  try { move = prepareEngineMove(board, 'addItem', [{ by: 'coordinator', lane: box.lane, title: recovered }]); }
  finally { closeBoard(board); }
  // relay on set up the coordinator's own token from the person sign-in, with no extra tap (#579).
  const agent = link.agentTokens.coordinator;
  assert.match(agent?.token ?? '', /^pa_[A-Za-z0-9_-]{43}$/u, 'relay on gives the coordinator its token without a phone tap');
  const sent = await upload(box, { ...link, token: agent.token }, 'moves', 1, await encoded(key, move, link.board, 'move', 1));
  const started = Date.now();
  const timeoutText = 'The relay snapshot has not caught up to this move. Retry this board.';
  await chrome.waitFor('document.querySelector("#relay-notice")?.textContent.includes(' + JSON.stringify(timeoutText) + ')', // budget: hang ceiling for observing the declared fifteen-second checkpoint timeout; no throughput claim.
    45_000, 'actual fifteen-second native checkpoint timeout');
  assert.ok(Date.now() - started >= 14_000, 'the production wait elapsed; no clock or fetch was replaced'); // budget: declared fifteen-second native checkpoint wait (14000ms lower bound).
  assert.equal(await chrome.evaluate('document.querySelector("#relay-notice").textContent.includes("Pending event #1")'), true,
    'the timeout retains the received pending event while checkpoint items remain authoritative');
  assert.equal(await chrome.evaluate('document.querySelector("#chain").textContent.includes(' + JSON.stringify(recovered) + ')'), false);

  const native = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    const outcome = applyRelayMove(native, move, { sequence: 1, at: sent.event.event_at, sender: sent.event.sender, kind: 'move' });
    assert.equal(outcome.error, undefined, 'the CLI engine applies exactly the acknowledged native operation');
  } finally { closeBoard(native); }
  const checkpoint = relaySnapshot(box.root, {}, RELAY_PRESENTATION_PORTS);
  assert.ok(checkpoint.presentation.state.items.some(item => item.title === recovered));

  // Neither an incorrectly keyed checkpoint nor truncated ciphertext is successful recovery.
  const wrongKey = await generateBoardKey();
  for (const [label, bytes, code] of [
    ['wrong key', await encoded(wrongKey, checkpoint, link.board, 'snapshot', 1), 'SEAL_AUTH_FAILED'],
    ['malformed ciphertext', Buffer.from([1, 2, 3]).toString('base64url'), 'SEAL_FORMAT'],
  ]) {
    await upload(box, link, 'state', 1, bytes);
    await assert.rejects(readState(chrome, link.board), error => error.code === code, label + ' remains refused');
    assert.equal(await chrome.evaluate('document.querySelector("#chain").textContent.includes(' + JSON.stringify(recovered) + ')'), false,
      label + ' cannot install the recovered projection');
    assert.equal(await chrome.evaluate('document.querySelector("#relay-notice").textContent.includes(' + JSON.stringify(timeoutText) + ')'), true,
      label + ' cannot clear the stale failure');
  }

  const streamsBeforeRecovery = streams();
  await upload(box, link, 'state', 1, await encoded(key, checkpoint, link.board, 'snapshot', 1));
  const result = await readState(chrome, link.board);
  assert.ok(result.state.items.some(item => item.title === recovered), 'the real page transport returns the authenticated native projection');
  // Inspect immediately, before another event can incidentally clear the failure.
  assert.equal(await chrome.evaluate('document.querySelector("#relay-notice").textContent.includes(' + JSON.stringify(timeoutText) + ')'), false,
    'successful authenticated state recovery clears the timeout notice');
  assert.equal(await chrome.evaluate('document.querySelector("#relay-notice").textContent.includes("Pending event #1")'), false,
    'only the covering authenticated checkpoint clears the pending mark');
  await chrome.evaluate('refresh()');
  await chrome.waitFor('document.querySelector("#chain")?.textContent.includes(' + JSON.stringify(recovered) + ')');
  assert.ok(streams() > streamsBeforeRecovery, 'the fatal old stream is replaced by a real authorized SSE connection');
  assert.equal(pageLoads(), originalLoads, 'checkpoint recovery does not reload the page');

  // The next ordinary CLI command catches up from the same checkpoint and authors a real native event.
  assert.equal((await box.cli('add', box.lane, later)).code, 0);
  await chrome.waitFor('document.querySelector("#chain")?.textContent.includes(' + JSON.stringify(later) + ')');
  assert.equal(await chrome.evaluate('document.querySelector("#relay-notice").textContent.includes(' + JSON.stringify(timeoutText) + ')'), false);
  assert.equal(pageLoads(), originalLoads, 'later native updates keep the recovered document');
  assert.equal(box.keyInRequest(), false, 'all native and browser relay traffic keeps the board key on the device');
});
