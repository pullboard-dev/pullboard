// pullboard: browser
/** @pullboard-test-gui */
/** A paired browser seals person intent; only native Pullboard executes it [H12,H16,B26]. These cases time and trace API1
 * snapshot PUTs, so they run on the legacy wire (#903); API2 person moves are proven in relay-person-actions.test.js. */
import assert from 'node:assert/strict';
import {
  readFileSync,
} from 'node:fs';
import {
  test,
} from 'node:test';
import {
  findChromeExecutable,
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
  DECLINE_FLOW_CLI_CHILDREN,
  approvalFlowTimeoutMs,
  pairedTransport,
  sendPersonIntent,
  finalState,
  addPendingSpecRow,
} from '../../../tests/fixtures/relay/requests.js';

test('coordinator decline resolves a paired approval request with a reason and leaves repo files unchanged [H12,H16,B26]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
  timeout: approvalFlowTimeoutMs(DECLINE_FLOW_CLI_CHILDREN),
}, async t => {
  const box = await relayClientFixture(t, { cliChildren: DECLINE_FLOW_CLI_CHILDREN });
  const row = addPendingSpecRow(box, 'G96');
  const before = readFileSync(row.path, 'utf8');
  const title = 'PERSON_REQUEST_DECLINE_FIXTURE';
  assert.equal((await box.cliLocal('add', box.lane, title)).code, 0);
  await box.link();
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  const link = await pairedTransport(chrome, box, title);
  const queued = await sendPersonIntent(chrome, link.board, { verb: 'spec-approve', args: { ids: 'G96' } });
  const delayedBefore = box.snapshotWriteDelays().length;
  const writeRecordsBefore = box.snapshotWriteRecords().length;
  box.delaySnapshotWrites(8000);
  const native = await box.cliWithSnapshotUploads(4, 'status').then(result => ({ result }), error => ({ error }));
  box.delaySnapshotWrites(0);
  assert.equal(native.error, undefined, 'the four-upload decline status fits its derived deadline');
  assert.equal(native.result.code, 0);
  const delays = box.snapshotWriteDelays().slice(delayedBefore);
  const trace = native.result.snapshotTrace;
  const writeRecords = box.snapshotWriteRecords().slice(writeRecordsBefore);
  t.diagnostic('decline status snapshot PUT evidence: ' + JSON.stringify({
    fetches: trace, relayReceives: writeRecords, delays,
  }));
  assert.equal(trace.length, delays.length, 'every delayed decline upload has a matching client fetch trace');
  assert.deepEqual(trace.map(({ sequence, ciphertext }) => ({ sequence, ciphertext })),
    writeRecords.map(({ sequence, ciphertext }) => ({ sequence, ciphertext })),
    'the private client and relay traces identify each decline checkpoint');
  assert.ok(trace.every(write => write.callers.some(caller => caller.includes('publishCheckpoint'))),
    'each decline upload comes from checkpoint publication');
  assert.equal(native.result.snapshotUploads, trace.length);
  assert.equal(native.result.snapshotDeadlineMs, cliChildDeadlineMs(trace.length),
    'the decline status deadline follows its observed uploads');
  assertSnapshotCheckpoints(trace, 4);
  assert.ok(delays.every(delay => delay >= 7900), 'the relay delayed every decline snapshot by 8 seconds'); // budget: declared eight-second decline snapshot delay (7900ms lower bound).
  const pending = (await finalState(chrome, link.board)).state.personRequests.find(record => record.id === queued.result.request.id);
  assert.equal(pending.status, 'waiting');
  assert.ok(Number.isSafeInteger(pending.coordinatorRequest));
  const missingReason = await box.cliLocal('answer', String(pending.coordinatorRequest), 'declined');
  assert.equal(missingReason.code, 1);
  assert.equal(missingReason.document.error.code, 'REQUEST_OUTCOME');
  const reason = 'Waiting for a revised requirement';
  assert.equal((await box.cliLocal('answer', String(pending.coordinatorRequest), 'declined ' + reason)).code, 0);
  const completed = (await finalState(chrome, link.board)).state.personRequests.find(record => record.id === queued.result.request.id);
  assert.equal(completed.status, 'refused');
  assert.deepEqual(completed.error, { code: 'REQUEST_DECLINED', message: reason, next: 'Read the coordinator reason and send a revised request from the view.' });
  assert.equal(readFileSync(row.path, 'utf8'), before, 'declining the repository request does not edit any row');
  assert.deepEqual((await box.cliLocal('resume')).document.requests, [], 'the declined request leaves the open coordinator queue');
  box.assertCliChildrenComplete();
});

/** Exercise the real product abort and require the persisted checkpoint to keep its sealed bytes. */
