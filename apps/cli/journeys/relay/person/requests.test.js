// pullboard: browser
/** @pullboard-test-gui */
/** A paired browser seals person intent; only native Pullboard executes it [H12,H16,B26]. These cases time and trace API1
 * snapshot PUTs, so they run on the legacy wire (#903); API2 person moves are proven in relay-person-actions.test.js. */
import assert from 'node:assert/strict';
import {
  randomUUID,
} from 'node:crypto';
import {
  readFileSync,
} from 'node:fs';
import {
  performance,
} from 'node:perf_hooks';
import {
  test,
} from 'node:test';
import {
  decodeBoardKey,
} from '../../../../../packages/kernel/index.js';
import {
  seal,
} from '../../../../../packages/kernel/index.js';
import {
  ENGINE_VERSION,
} from '../../../../../packages/state/index.js';
import {
  findChromeExecutable,
} from '../../../tests/fixtures/relay/browser.js';
import {
  relayWorkBudgetMs,
} from '../../../tests/fixtures/relay/browser.js';
import {
  startChrome,
} from '../../../tests/fixtures/relay/browser.js';
import {
  assertSnapshotCheckpoints,
} from '../../../tests/fixtures/relay/client.js';
import {
  cliChildDeadlineMs,
} from '../../../tests/fixtures/relay/client.js';
import {
  legacyRelayClientFixture as relayClientFixture,
} from '../../../tests/fixtures/relay/client.js';
import {
  stableChrome,
} from '../../../tests/fixtures/cockpit/stable.js';
import {
  CHROME_START_BUDGET_MS,
  lateSnapshotTiming,
  showItem,
  pairedTransport,
  installRequestTransport,
  sendPersonIntent,
  waitForRequest,
  addPendingSpecRow,
} from '../../../tests/fixtures/relay/requests.js';

test('real paired Chrome transports a person shout while its native snapshot is 8 seconds late [H12,H16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const timing = lateSnapshotTiming(t);
  try {
    timing.begin('fixture setup and item creation', '4 serial private CLI children; each has the existing 55,000 ms child bound');
    const box = await relayClientFixture(t);
    const title = 'PERSON_REQUEST_SHOUT_FIXTURE';
    assert.equal((await box.cli('add', box.lane, title)).code, 0);
    timing.finish();
    timing.begin('relay link', cliChildDeadlineMs(3));
    await box.link();
    timing.finish();
    timing.begin('Chrome startup', CHROME_START_BUDGET_MS);
    const chrome = await stableChrome(await startChrome());
    t.after(() => chrome.close());
    timing.finish();
    const link = await pairedTransport(chrome, box, title, timing);
    timing.begin('person shout transport action', relayWorkBudgetMs());
    const move = { verb: 'shout', args: { to: 'coordinator', text: 'PERSON_REQUEST_SHOUT_LITERAL' } };
    const receipt = await sendPersonIntent(chrome, link.board, move);

    assert.equal(receipt.version, 1);
    assert.equal(receipt.result.request.status, 'waiting');
    assert.deepEqual(receipt.result.request.move, move);
    assert.equal(typeof receipt.result.request.id, 'string');
    assert.equal(await chrome.stable("document.querySelector('#relay-notice').textContent"),
      '1 request from this device is waiting for a linked machine to run Pullboard.',
      'the paired browser identifies only its own acknowledged waiting request');
    assert.equal(box.calls.some(call => call.method === 'POST' && call.path === `/api/v1/boards/${link.board}/requests`), true,
      'the browser posts a sealed request document, not an executable engine move');
    assert.equal(box.keyInRequest(), false, 'the device key never enters an HTTP request');
    timing.finish();
    timing.begin('relay event privacy read', 'direct local fetch has no explicit per-call timeout');
    const session = JSON.parse(readFileSync(box.linkFile, 'utf8'));
    const rawResponse = await fetch(box.origin + '/api/v1/boards/' + link.board + '/events?after=0', { headers: { authorization: 'Bearer ' + session.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
    assert.equal(rawResponse.status, 200);
    const raw = await rawResponse.json();
    assert.equal(JSON.stringify(raw).includes(move.args.text), false, 'the relay response contains opaque ciphertext rather than request text');
    const sealedRequest = raw.events.find(row => row.kind === 'request');
    assert.ok(sealedRequest && typeof sealedRequest.sealed === 'string');
    timing.finish();

    timing.begin('browser reload and readiness', relayWorkBudgetMs());
    const reloadedFrom = await chrome.stable('performance.timeOrigin');
    await chrome.send('Page.reload');
    await showItem(chrome, title, reloadedFrom);
    assert.equal(await chrome.stable("document.querySelector('#relay-notice').textContent"),
      '1 request from this device is waiting for a linked machine to run Pullboard.',
      'the device-local request id survives a page reload without storing its text');
    timing.finish();
    await installRequestTransport(chrome, timing);

    const delayedBefore = box.snapshotWriteDelays().length;
    const writeRecordsBefore = box.snapshotWriteRecords().length;
    timing.begin('native status child and delayed checkpoint uploads', `initial child bound ${cliChildDeadlineMs(3)} ms for 3 uploads`);
    box.delaySnapshotWrites(8000);
    const native = box.cliWithSnapshotTrace(3, 'status').then(result => ({ result }), error => ({ error }));
    const status = await native;
    box.delaySnapshotWrites(0);
    const observedUploads = box.snapshotWriteRecords().length - writeRecordsBefore;
    timing.updateWait(`initial ${cliChildDeadlineMs(3)} ms; current upload-derived bound ${cliChildDeadlineMs(Math.max(3, observedUploads))} ms for ${observedUploads} observed uploads`);
    assert.equal(status.error, undefined, 'the next native status receives and executes the queued intent');
    assert.equal(status.result.code, 0, 'the next native status reports success');
    const delays = box.snapshotWriteDelays().slice(delayedBefore);
    const trace = status.result.snapshotTrace;
    const writeRecords = box.snapshotWriteRecords().slice(writeRecordsBefore);
    t.diagnostic('person shout status snapshot PUT sources: ' + JSON.stringify({ fetches: trace, relayReceives: writeRecords }));
    assert.equal(trace.length, delays.length, 'every delayed state upload has a matching private fetch trace');
    assert.deepEqual(trace.map(({ sequence, ciphertext }) => ({ sequence, ciphertext })),
      writeRecords.map(({ sequence, ciphertext }) => ({ sequence, ciphertext })),
      'the private trace matches only snapshots received by the isolated relay');
    assert.ok(trace.every(write => write.callers.some(line => line.includes('publishCheckpoint'))), 'each traced upload came from checkpoint publication');
    assert.equal(status.result.snapshotUploads, trace.length);
    assert.equal(status.result.snapshotDeadlineMs, cliChildDeadlineMs(trace.length), 'the child deadline follows this run’s observed upload count');
    assertSnapshotCheckpoints(trace, 3);
    assert.ok(delays.every(delay => delay >= 7900), 'the relay delayed every native snapshot by 8 seconds'); // budget: declared eight-second native snapshot delay (7900ms lower bound).
    timing.finish();
    timing.begin('paired-browser request completion poll', '85,000 ms in-page poll; 110,000 ms outer CDP task bound');
    const latest = await waitForRequest(chrome, link.board, receipt.result.request.id, 'done');
    assert.equal(await chrome.stable("document.querySelector('#relay-notice').textContent"), '',
      'the completed local request no longer appears as waiting');
    const personShouts = latest.state.shouts.filter(shout => shout.shout_from === 'person' && shout.shout_text === move.args.text);
    assert.equal(personShouts.length, 1, 'the authored person shout occurs exactly once');
    timing.finish();
    timing.begin('final export', cliChildDeadlineMs(3));
    const exported = (await box.cli('export')).document;
    assert.equal(exported.tables.shout.filter(shout => shout.shout_from === 'person' && shout.shout_text === move.args.text).length, 1);
    timing.finish();
  } catch (error) {
    timing.reportFailure(error);
    throw error;
  }
});


test('an agent-sealed row approval is refused before any row receipt or spec edit [H12,H16,B26]', async t => {
  const box = await relayClientFixture(t);
  const id = 'G97';
  const row = addPendingSpecRow(box, id);
  const before = readFileSync(row.path, 'utf8');
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const personToken = link.token;
  const tokenResponse = await fetch(box.origin + '/auth/tokens', {
    method: 'POST', headers: { authorization: 'Bearer ' + personToken, 'content-type': 'application/json' },
    body: JSON.stringify({ board: link.board, agent: 'request-fixture-agent' }),
  });
  assert.equal(tokenResponse.status, 201, 'the signed-in person can issue a scoped agent token');
  const agentToken = (await tokenResponse.json()).token;
  const snapshotResponse = await fetch(box.origin + '/api/v1/boards/' + link.board + '/state', {
    headers: { authorization: 'Bearer ' + personToken, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(snapshotResponse.status, 200);
  const sequence = (await snapshotResponse.json()).state.sequence + 1;
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const document = { version: 1, type: 'person-request', id: randomUUID(), move: { verb: 'spec-approve', args: { ids: id } } };
  const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(document)), {
    boardId: link.board, kind: 'request', sequence,
  })).toString('base64url');
  const uploaded = await fetch(box.origin + '/api/v1/boards/' + link.board + '/requests', {
    method: 'POST', headers: { authorization: 'Bearer ' + agentToken, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body: JSON.stringify({ sequence, sealed }),
  });
  assert.equal(uploaded.status, 200, 'the opaque journal accepts authenticated ciphertext without interpreting it');
  assert.equal((await box.cli('status')).code, 0, 'native replay records the sender refusal');
  const exported = (await box.cli('export')).document;
  const receipts = JSON.parse(exported.tables.board_meta.find(row => row.meta_key === 'relay_person_requests').meta_value);
  const refused = receipts.find(entry => entry.id === document.id);
  assert.equal(refused.status, 'refused');
  assert.equal(refused.error.code, 'RELAY_PERSON_ONLY');
  assert.equal(exported.tables.event.some(event => event.event_kind === 'row_decision' && JSON.parse(event.event_detail).record.id === id), false);
  assert.equal(readFileSync(row.path, 'utf8'), before, 'agent intent cannot create a person receipt or change SPEC.md');
});

