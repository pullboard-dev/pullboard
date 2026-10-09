/** A paired browser retries only saved ciphertext after an interrupted person request [H12,H16,H17]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';
import { cliChildDeadlineMs, relayClientFixture } from './relay-client-fixture.js';

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
  const task = await chrome.startTask(`(async () => {
    const { createTransport } = await import('/relay/client.js');
    window.__personOutboxTransport = await createTransport({ onUpdate: () => {} });
    return true;
  })()`, 'initialize person outbox transport');
  await chrome.pollTask(task, 25000, 'initialize person outbox transport');
}

/** Read a final state without keeping a single DevTools evaluation open during relay work. */
async function finalState(chrome, board) {
  const task = await chrome.startTask('window.__personOutboxTransport.request('
    + JSON.stringify('/api/v1/boards/' + board + '/state') + ')', 'read person outbox state');
  return chrome.pollTask(task, 25000, 'read person outbox state');
}

/** Poll the device-decrypted outbox receipt while native status publishes its snapshot. */
async function waitForRequest(chrome, board, id, status) {
  const path = '/api/v1/boards/' + board + '/state';
  const task = await chrome.startTask(`(async () => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        const state = await window.__personOutboxTransport.request(${JSON.stringify(path)});
        if (state.state?.personRequests?.some(entry => entry.id === ${JSON.stringify(id)} && entry.status === ${JSON.stringify(status)})) return state;
      } catch { /* The native snapshot may still be in flight. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The person outbox receipt did not reach its expected status.');
  })()`, 'wait for person outbox receipt');
  return chrome.pollTask(task, 30000, 'wait for person outbox receipt');
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
  const interruptedTask = await chrome.startTask(`window.__personOutboxTransport.request(
    ${JSON.stringify('/api/v1/boards/' + link.board + '/moves')},
    ${JSON.stringify({ verb: 'shout', args: { to: 'coordinator', text } })}
  )`, 'submit interrupted person request');
  let interrupted;
  try { interrupted = await chrome.pollTask(interruptedTask, 25000, 'submit interrupted person request'); }
  catch (error) { interrupted = { code: error.code }; }
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
  const state = await finalState(chrome, link.board);
  const requestId = outbox[0].record.id;
  const receipt = state.state.personRequests.find(row => row.id === requestId);
  assert.equal(receipt?.status, 'waiting', 'a read flushes the saved request after the service recovers');
  assert.deepEqual(receipt.move, { verb: 'shout', args: { to: 'coordinator', text } });
  outbox = await chrome.evaluate(`(() => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    .filter(key => key?.startsWith(${JSON.stringify(outboxPrefix)})))()`);
  assert.deepEqual(outbox, [], 'the relay acknowledgement removes the device outbox entry');

  const delayedBefore = box.snapshotWriteDelays().length;
  const writeRecordsBefore = box.snapshotWriteRecords().length;
  box.delaySnapshotWrites(8000);
  const native = box.cliWithSnapshotTrace(3, 'status').then(result => ({ result }), error => ({ error }));
  const status = await native;
  box.delaySnapshotWrites(0);
  assert.equal(status.error, undefined, 'the native linked machine executes the recovered request');
  assert.equal(status.result.code, 0, 'the native linked machine reports success');
  const delays = box.snapshotWriteDelays().slice(delayedBefore);
  const trace = status.result.snapshotTrace;
  const writeRecords = box.snapshotWriteRecords().slice(writeRecordsBefore);
  t.diagnostic('status snapshot PUT sources: ' + JSON.stringify(trace.map(write => ({
    at: write.at, sequence: write.sequence, ciphertext: write.ciphertext, callers: write.callers, elapsedMs: write.elapsedMs,
  }))));
  assert.equal(trace.length, delays.length, 'every delayed state upload has a matching private fetch trace');
  assert.deepEqual(trace.map(({ sequence, ciphertext }) => ({ sequence, ciphertext })),
    writeRecords.map(({ sequence, ciphertext }) => ({ sequence, ciphertext })),
    'the private trace matches only snapshots received by the isolated relay');
  assert.ok(trace.every(write => write.callers.some(line => line.includes('publishCheckpoint'))), 'each traced upload came from checkpoint publication');
  assert.equal(status.result.snapshotUploads, trace.length);
  assert.equal(status.result.snapshotDeadlineMs, cliChildDeadlineMs(trace.length), 'the child deadline follows this run’s observed upload count');
  assert.equal(delays.length, 3, 'this three-upload status flow uploads exactly three snapshots');
  assert.ok(delays.every(delay => delay >= 7900), 'the relay delayed every native snapshot by 8 seconds');
  const completed = await waitForRequest(chrome, link.board, requestId, 'done');
  const exported = (await box.cli('export')).document;
  const shouts = exported.tables.shout.filter(row => row.shout_from === 'person' && row.shout_text === text);
  assert.equal(shouts.length, 1, 'one recovered intent creates exactly one authored person shout');
  assert.equal(completed.state.personRequests.find(row => row.id === requestId).status, 'done');
  const repeatedState = await finalState(chrome, link.board);
  assert.equal(repeatedState.state.personRequests.find(row => row.id === requestId).status, 'done');
  const control = await box.cliWithSnapshotTrace(0, 'status');
  assert.equal(control.code, 0, 'repeated native replay stays idempotent');
  assert.equal(control.snapshotTrace.length, 0, 'a completed request status has no checkpoint to republish');
  assert.equal(control.snapshotDeadlineMs, cliChildDeadlineMs(0), 'a no-upload control keeps only the product bound and margin');
  const repeatedExport = (await box.cli('export')).document;
  assert.equal(repeatedExport.tables.shout.filter(row => row.shout_from === 'person' && row.shout_text === text).length, 1);
});
