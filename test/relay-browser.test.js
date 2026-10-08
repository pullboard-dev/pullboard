/** Real Chrome reads and follows device-sealed boards; the relay never receives its key [H5,H15,H18]. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { snapshotState, presentationState } from '../relay/browser-model.js';
import { decodeBoardKey, unseal } from '../src/seal.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';

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
  assert.throws(() => snapshotState(box.before, '0'.repeat(32)), { code: 'RELAY_SNAPSHOT' });
  assert.throws(() => snapshotState({ ...box.before, version: 2 }, id), { code: 'RELAY_SNAPSHOT' });
  assert.throws(() => presentationState({ version: 2, state }, id), { code: 'RELAY_PRESENTATION' });
});

test('conditional sealed snapshots reauthorize before 304 and refresh spec-only presentation [H5,H15]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const endpoint = box.origin + '/api/v1/boards/' + link.board + '/state';
  const headers = { authorization: 'Bearer ' + link.token };
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

test('real Chrome pairs, retains its device key, follows SSE without polling and shows inactivity [H5,H15,H18]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const firstTitle = 'SEALED_BROWSER_INITIAL_108';
  const liveTitle = 'SEALED_BROWSER_LIVE_108';
  assert.equal((await box.cli('add', box.lane, firstTitle)).code, 0);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const encoded = readFileSync(box.keyFile, 'utf8').trim();
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

  assert.equal((await box.cli('add', box.lane, liveTitle)).code, 0);
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(liveTitle) + ')');
  assert.equal(await chrome.evaluate("document.querySelector('#relay-notice').textContent.includes('Acting from the relay is coming')"), true);
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(liveTitle) + ')');
  assert.equal(await chrome.evaluate('location.hash === ""'), true, 'a later visit needs no new pairing link');
  box.advance(80);
  await chrome.waitFor("document.querySelector('#relay-notice')?.textContent.includes('BOARD_INACTIVE') && document.querySelector('#relay-notice').textContent.includes('10 days left')");
  assert.equal(box.keyInRequest(), false, 'the key was never in an HTTP URL or header');
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
  await signIn(chrome, box);
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(marker) + ')');

  const wrong = await startChrome();
  t.after(() => wrong.close());
  await signIn(wrong, box);
  await wrong.navigate(box.origin + '/#board=' + link.board + '&key=' + 'A'.repeat(43));
  await wrong.waitFor("document.querySelector('#relay-notice')?.textContent.includes('Could not open')");
  assert.equal(await wrong.evaluate('document.body.textContent.includes(' + JSON.stringify(marker) + ')'), false);
  assert.equal(box.keyInRequest(), false);
});
