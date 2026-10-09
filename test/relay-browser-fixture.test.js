/** Real Chrome fixture diagnostics and timeout boundary [H16,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ENGINE_VERSION } from '../src/machine.js';
import { relayClientFixture } from './relay-client-fixture.js';
import { findChromeExecutable, relayWorkBudgetMs, startChrome } from './relay-browser-fixture.js';

/** Assert the fixed CDP bound reports its command context and relay-request state. */
async function stalledCommand(chrome, label, pending) {
  await assert.rejects(
    chrome.evaluate('new Promise(resolve => setTimeout(resolve, 16000))', label),
    error => {
      assert.match(error.message, /Runtime\.evaluate/);
      assert.match(error.message, new RegExp(label));
      assert.match(error.message, /timed out after 1[45]\d{3}ms/);
      assert.match(error.message, /maximum event-loop delay \d+ms/);
      assert.match(error.message, new RegExp('relay request pending: ' + pending));
      return true;
    },
  );
}

test('real Chrome names the stalled command when a 16-second page promise exceeds the CDP bound [H16,C7]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const chrome = await startChrome({ commandTimeoutMs: 15000 });
  t.after(() => chrome.close());
  await stalledCommand(chrome, '16-second stalled-command probe', false);
  const task = await chrome.startTask('new Promise(resolve => setTimeout(resolve, 16000))', 'navigation cleanup probe');
  await chrome.navigate('about:blank');
  await assert.rejects(chrome.pollTask(task, 250, 'task lost to navigation'), /did not arrive within 250ms/);
});

test('paired Chrome excludes idle event streams and reports only held state requests [H16,C7]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const chrome = await startChrome({ commandTimeoutMs: 15000 });
  t.after(() => chrome.close());
  const cookie = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(cookie.success, true);
  // A static same-origin document has no cockpit refresh timer to start ordinary reads mid-probe.
  await chrome.navigate(box.origin + '/view.css');
  await chrome.waitFor('document.readyState === "complete"');
  const stateResponse = await fetch(box.origin + '/api/v1/boards/' + link.board + '/state', {
    headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(stateResponse.status, 200);
  const snapshot = (await stateResponse.json()).state;
  const streamPath = '/api/v1/boards/' + link.board + '/events?after=' + snapshot.sequence;
  const streamTask = await chrome.startTask(`fetch(${JSON.stringify(streamPath)}, {
    credentials: 'same-origin', headers: { 'x-pullboard-engine': ${ENGINE_VERSION}, accept: 'text/event-stream' }
  }).then(response => { window.__diagnosticStream = response.body.getReader();
    return { status: response.status, type: response.headers.get('content-type') }; })`, 'authenticated idle event stream');
  const stream = await chrome.pollTask(streamTask);
  assert.equal(stream.status, 200);
  assert.match(stream.type, /text\/event-stream/);
  assert.ok(box.calls.some(call => call.path === streamPath && call.accept === 'text/event-stream'),
    'the real relay accepted the idle event stream before the stalled probe');
  await assert.doesNotReject(chrome.waitForRelayIdle(), 'a real idle event stream is excluded from ordinary pending requests');
  await stalledCommand(chrome, 'idle paired stream probe', false);

  const before = box.stateReadStarted();
  box.delayStateReads(30000);
  const stateTask = await chrome.startTask(`fetch(${JSON.stringify('/api/v1/boards/' + link.board + '/state')}, { credentials: 'same-origin', headers: { 'x-pullboard-engine': ${ENGINE_VERSION} } })
    .then(response => response.status)`, 'held paired state read');
  const deadline = Date.now() + relayWorkBudgetMs(1);
  while (box.stateReadStarted() === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(box.stateReadStarted() > before, 'the authenticated state request reached the private relay');
  await stalledCommand(chrome, 'held paired state probe', true);
  await chrome.navigate('about:blank');
  box.delayStateReads(0);
  await stalledCommand(chrome, 'navigation-cleared paired request probe', false);
  await assert.rejects(chrome.pollTask(stateTask, 250, 'state task lost to navigation'), /did not arrive within 250ms/);
});


test('relay idle readiness waits for a real held request and then observes its completion [H16,C7]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await chrome.navigate(box.origin);
  await chrome.waitFor('document.readyState === "complete"');
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const release = box.holdStateReads();
  t.after(release);
  const before = box.stateReadStarted();
  const task = await chrome.startTask(`fetch(${JSON.stringify('/api/v1/boards/')} + ${JSON.stringify(link.board)} + '/state', {
    headers: { authorization: 'Bearer ' + ${JSON.stringify(link.token)}, 'x-pullboard-engine': ${ENGINE_VERSION} }
  }).then(async response => { await response.arrayBuffer(); return response.status; })`, 'idle readiness held request');
  await chrome.waitFor('true');
  const deadline = Date.now() + relayWorkBudgetMs(1);
  while (box.stateReadStarted() === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(box.stateReadStarted() > before);
  await assert.rejects(chrome.waitForRelayIdle(200), /did not become idle within 200ms/);
  release();
  assert.equal(await chrome.pollTask(task), 200);
  await chrome.waitForRelayIdle();
});
