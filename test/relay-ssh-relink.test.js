/** Public SSH CLI and cookie-bound auth protocol retain one active repository link [E12,H5,H16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { relayClientFixture } from './relay-client-fixture.js';

const PROMPT = 'After sign-in, confirm the link in your browser: ';

/** Send one ordinary same-origin confirmation request, carrying only the real issued cookie. */
async function confirmation(box, route, body, cookie) {
  const response = await fetch(box.origin + '/auth/device/confirmation' + route, {
    method: 'POST', headers: { origin: box.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('SSH relay off then on confirms replacement and retains the old-board off receipt [E12,H5,H16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const previous = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  assert.equal((await box.cli('relay', 'off')).code, 0, 'ordinary local off finishes first');
  const running = box.startCli(['relay', 'on', '--url', box.origin], { SSH_CONNECTION: '192.0.2.10 12345 192.0.2.20 22' });
  try {
    const output = await running.waitForOutput(PROMPT);
    const line = output.split('\n').find(row => row.includes(PROMPT));
    const address = new URL(line.slice(line.indexOf(PROMPT) + PROMPT.length).trim());
    assert.equal(address.origin, box.origin);
    const ticket = decodeURIComponent(address.hash.slice(1));
    const opened = await confirmation(box, '/open', { ticket });
    assert.equal(opened.status, 200);
    let ready;
    const deadline = Date.now() + 30_000; // budget: private device-flow readiness hang ceiling, not a speed target.
    do {
      ready = await confirmation(box, '/status', { ticket }, opened.cookie);
      assert.equal(ready.status, 200);
      if (!ready.value.ready) await new Promise(done => setTimeout(done, 20));
    } while (!ready.value.ready && Date.now() < deadline);
    assert.equal(ready.value.ready, true, 'real GitHub device grant reaches browser confirmation');
    assert.equal(ready.value.intent.replaces, previous, 'the person confirms the immutable previous board, not an unbound request field');
    assert.equal(box.auth.boardOff(previous), null, 'opening and reading confirmation never retires the old link');
    const result = await confirmation(box, '', { ticket, decision: 'confirm' }, opened.cookie);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.equal(result.value.confirmed, true);
    const completed = await running.closed;
    assert.equal(completed.code, 0, 'the actual SSH CLI receives the confirmed replacement');
    const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
    assert.notEqual(state.board, previous);
    assert.deepEqual({ ...box.auth.boardOff(previous) }, { board: previous, replacedBy: state.board, userId: '7', at: box.auth.boardOff(previous).at });
    assert.equal(JSON.parse(readFileSync(box.root + '/pullboard.json', 'utf8')).relay.board, state.board);
    const sessions = box.auth.linkedBoards().filter(row => !box.auth.boardOff(row.id));
    assert.deepEqual(sessions.map(row => row.id), [state.board], 'exactly one repository link stays active');
  } finally {
    if (running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill('SIGTERM');
      await running.closed;
    }
  }
});


/** Complete only the existing public device-grant protocol, without minting authority outside it. */
async function publicIntent(box, intent) {
  const start = await fetch(box.origin + '/auth/device/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent }) });
  assert.equal(start.status, 200);
  const grant = await start.json();
  const ticket = decodeURIComponent(new URL(grant.confirmationURL).hash.slice(1));
  const opened = await confirmation(box, '/open', { ticket });
  assert.equal(opened.status, 200);
  let status;
  const deadline = Date.now() + 30_000; // budget: real private OAuth polling hang ceiling, not a speed assertion.
  do {
    const poll = await fetch(box.origin + '/auth/device/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: grant.ticket }) });
    assert.equal(poll.status, 200);
    status = await confirmation(box, '/status', { ticket }, opened.cookie);
    if (!status.value.ready) await new Promise(done => setTimeout(done, 20));
  } while (!status.value.ready && Date.now() < deadline);
  assert.equal(status.value.ready, true);
  return { ticket, cookie: opened.cookie, status: status.value };
}

test('SSH replacement requires the active board and an exact authenticated confirmation [E12,H5,H16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const previous = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  const next = 'b'.repeat(32);
  const intent = { board: next, repository: 'fixture/repository', host: 'private-host', boardName: 'private-board' };
  const missing = await publicIntent(box, intent);
  const denied = await confirmation(box, '', { ticket: missing.ticket, decision: 'confirm' }, missing.cookie);
  assert.equal(denied.value.error.code, 'BOARD_REPO_LINKED', 'omitting a replacement never creates a second active link');
  const stale = await publicIntent(box, { ...intent, replaces: 'a'.repeat(32) });
  const invalid = await confirmation(box, '', { ticket: stale.ticket, decision: 'confirm' }, stale.cookie);
  assert.equal(invalid.value.error.code, 'BOARD_REPLACE', 'a merely well-formed unrelated id grants no replacement authority');
  assert.equal(box.auth.boardOff(previous), null);
  assert.deepEqual(box.auth.linkedBoards().map(row => row.id), [previous]);
  for (const replaces of [null, {}, '../old-board']) {
    const response = await fetch(box.origin + '/auth/device/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent: { ...intent, replaces } }) });
    assert.equal(response.status, 400, 'malformed replacement intent is refused before device sign-in');
  }
  const valid = await publicIntent(box, { ...intent, replaces: previous });
  const foreign = await fetch(box.origin + '/auth/device/confirmation', { method: 'POST', headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json', cookie: valid.cookie }, body: JSON.stringify({ ticket: valid.ticket, decision: 'confirm' }) });
  assert.equal(foreign.status, 403, 'replacement keeps the existing same-origin person confirmation boundary');
  assert.equal(box.auth.boardOff(previous), null);
  const granted = await confirmation(box, '', { ticket: valid.ticket, decision: 'confirm' }, valid.cookie);
  assert.equal(granted.status, 200);
  const receipt = box.auth.boardOff(previous);
  assert.equal(receipt.replacedBy, next);
  assert.equal(receipt.userId, '7');
  const repeated = await confirmation(box, '', { ticket: valid.ticket, decision: 'confirm' }, valid.cookie);
  assert.equal(repeated.status, 200, 'same confirmed flow is idempotent');
  assert.deepEqual(box.auth.boardOff(previous), receipt, 'a repeated confirmation never replaces its durable off receipt');
});
