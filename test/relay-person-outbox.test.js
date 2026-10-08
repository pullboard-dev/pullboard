/** A paired browser retries only saved ciphertext after an interrupted person request [H12,H16,H17]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';
import { relayClientFixture } from './relay-client-fixture.js';

/** Install only the private fixture's person cookie in the real browser. */
async function signIn(chrome, box) {
  const session = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const result = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: session.token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(result.success, true);
}

/** Pair a real browser and initialize the production transport without using UI actions. */
async function pairedTransport(chrome, box, title) {
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = readFileSync(box.keyFile, 'utf8').trim();
  await signIn(chrome, box);
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + key);
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(title) + ')');
  await installTransport(chrome);
  return link;
}

/** Initialize the real transport on the currently loaded document. */
async function installTransport(chrome) {
  await chrome.evaluate(`(async () => {
    const { createTransport } = await import('/relay/client.js');
    window.__personOutboxTransport = await createTransport({ onUpdate: () => {} });
    return true;
  })()`);
}

test('real Chrome keeps an interrupted person request sealed and retries it once after reload [H12,H16,H17]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const title = 'PERSON_OUTBOX_BROWSER_READY';
  const text = 'PERSON_OUTBOX_PRIVATE_REQUEST_TEXT';
  assert.equal((await box.cli('add', box.lane, title)).code, 0);
  await box.link();
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const link = await pairedTransport(chrome, box, title);
  const outboxPrefix = 'pullboard.relay.requests.v1.' + link.board + '.';

  box.refuseRequestWrites(true);
  const interrupted = await chrome.evaluate(`window.__personOutboxTransport.request(
    ${JSON.stringify('/api/v1/boards/' + link.board + '/moves')},
    ${JSON.stringify({ verb: 'shout', args: { to: 'coordinator', text } })}
  ).then(() => ({ code: null }), error => ({ code: error.code }))`);
  assert.equal(interrupted.code, 'RELAY_UNAVAILABLE');
  let outbox = await chrome.evaluate(`(() => {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(key => key?.startsWith(${JSON.stringify(outboxPrefix)}));
    return keys.map(key => ({ key, record: JSON.parse(localStorage.getItem(key)) }));
  })()`);
  assert.equal(outbox.length, 1, 'the interrupted intent has one independently stored outbox record');
  assert.deepEqual(Object.keys(outbox[0].record).sort(), ['id', 'sealed', 'sequence']);
  assert.equal(outbox[0].key, outboxPrefix + outbox[0].record.id);
  assert.equal(outbox[0].record.sequence, 1);
  assert.doesNotMatch(JSON.stringify(outbox[0].record), new RegExp(text));
  assert.equal(JSON.stringify(outbox[0].record).includes(readFileSync(box.keyFile, 'utf8').trim()), false,
    'the outbox keeps only the sealed request, never the pairing key');
  assert.equal(box.calls.some(call => call.method === 'POST' && call.path === `/api/v1/boards/${link.board}/requests`), true,
    'the real request endpoint returned the fixture outage');

  box.refuseRequestWrites(false);
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(title) + ')');
  await installTransport(chrome);
  const statePath = '/api/v1/boards/' + link.board + '/state';
  const state = await chrome.evaluate('window.__personOutboxTransport.request(' + JSON.stringify(statePath) + ')');
  const requestId = outbox[0].record.id;
  const receipt = state.state.personRequests.find(row => row.id === requestId);
  assert.equal(receipt?.status, 'waiting', 'a read flushes the saved request after the service recovers');
  assert.deepEqual(receipt.move, { verb: 'shout', args: { to: 'coordinator', text } });
  outbox = await chrome.evaluate(`(() => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    .filter(key => key?.startsWith(${JSON.stringify(outboxPrefix)})))()`);
  assert.deepEqual(outbox, [], 'the relay acknowledgement removes the device outbox entry');

  assert.equal((await box.cli('status')).code, 0, 'the native linked machine executes the recovered request');
  const exported = (await box.cli('export')).document;
  const shouts = exported.tables.shout.filter(row => row.shout_from === 'person' && row.shout_text === text);
  assert.equal(shouts.length, 1, 'one recovered intent creates exactly one authored person shout');
  const repeatedState = await chrome.evaluate('window.__personOutboxTransport.request(' + JSON.stringify(statePath) + ')');
  assert.equal(repeatedState.state.personRequests.find(row => row.id === requestId).status, 'done');
  assert.equal((await box.cli('status')).code, 0, 'repeated native replay stays idempotent');
  const repeatedExport = (await box.cli('export')).document;
  assert.equal(repeatedExport.tables.shout.filter(row => row.shout_from === 'person' && row.shout_text === text).length, 1);
});
