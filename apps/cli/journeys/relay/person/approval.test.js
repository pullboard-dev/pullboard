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
  legacyRelayClientFixture as relayClientFixture,
} from '../../../tests/fixtures/relay/client.js';
import {
  stableChrome,
} from '../../../tests/fixtures/cockpit/stable.js';
import {
  APPROVAL_FLOW_CLI_CHILDREN,
  approvalFlowTimeoutMs,
  pairedTransport,
  sendPersonIntent,
  waitForRequest,
  addPendingSpecRow,
} from '../../../tests/fixtures/relay/requests.js';

test('real paired Chrome approval remains pending until coordinator applies and answers; invalid add keeps its CLI refusal [H12,H16,B26]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
  timeout: approvalFlowTimeoutMs(APPROVAL_FLOW_CLI_CHILDREN),
}, async t => {
  const box = await relayClientFixture(t, { cliChildren: APPROVAL_FLOW_CLI_CHILDREN });
  const title = 'PERSON_REQUEST_APPROVAL_FIXTURE';
  const id = 'G98';
  const row = addPendingSpecRow(box, id);
  assert.equal((await box.cliLocal('add', box.lane, title)).code, 0);
  await box.link();
  const chrome = await stableChrome(await startChrome());
  t.after(() => chrome.close());
  const link = await pairedTransport(chrome, box, title);

  const before = readFileSync(row.path, 'utf8');
  const approval = await sendPersonIntent(chrome, link.board, { verb: 'spec-approve', args: { ids: id } });
  assert.equal(approval.result.request.status, 'waiting');
  assert.deepEqual(approval.result.request.move, { verb: 'spec-approve', args: { ids: id } });
  const delayedBefore = box.snapshotWriteDelays().length;
  box.delaySnapshotWrites(8000);
  const native = await box.cliWithSnapshotUploads(4, 'status').then(result => ({ result }), error => ({ error }));
  box.delaySnapshotWrites(0);
  assert.equal(native.error, undefined, 'the four-upload approval status fits its derived deadline');
  assert.equal(native.result.code, 0);
  const delays = box.snapshotWriteDelays().slice(delayedBefore);
  assertSnapshotCheckpoints(native.result.snapshotTrace, 4);
  assert.ok(delays.every(delay => delay >= 7900), 'the relay delayed every approval snapshot by 8 seconds'); // budget: declared eight-second approval snapshot delay (7900ms lower bound).
  const pendingState = await waitForRequest(chrome, link.board, approval.result.request.id, 'waiting', true);
  assert.equal(readFileSync(row.path, 'utf8'), before, 'the received approval records a row decision but does not edit SPEC.md');
  const decisionEvents = (await box.cliLocal('export')).document.tables.event.filter(event => event.event_kind === 'row_decision' && event.event_by === 'person');
  assert.equal(decisionEvents.length, 1, 'the native row decision is attributed to the person');
  assert.equal(JSON.parse(decisionEvents[0].event_detail).record.id, id);
  const coordinatorRequest = pendingState.state.personRequests.find(entry => entry.id === approval.result.request.id).coordinatorRequest;
  const resume = (await box.cliLocal('resume')).document;
  assert.equal(resume.requests[0].shout_id, coordinatorRequest, 'coordinator resume presents the pending repository request first');


  assert.equal((await box.cliLocal('spec', 'apply')).code, 0, 'the coordinator applies the recorded decision locally');
  assert.match(readFileSync(row.path, 'utf8'), new RegExp(`- ${id} \\[approved, aim\\]`));
  const requestId = pendingState.state.personRequests.find(entry => entry.id === approval.result.request.id).coordinatorRequest;
  assert.equal((await box.cliLocal('answer', String(requestId), 'done')).code, 0, 'the coordinator resolves the original request after applying it');
  const completed = await waitForRequest(chrome, link.board, approval.result.request.id, 'done');
  assert.equal(completed.state.personRequests.find(entry => entry.id === approval.result.request.id).status, 'done');

  const invalid = await sendPersonIntent(chrome, link.board, {
    verb: 'add', args: { lane: box.lane, title: 'PERSON_REQUEST_INVALID_SPEC', specs: 'G999' },
  });
  assert.equal(invalid.result.request.status, 'waiting');
  assert.equal((await box.cli('status')).code, 0, 'native CLI status records the exact command refusal without creating an item');
  const afterInvalid = (await box.cliLocal('export')).document;
  assert.equal(afterInvalid.tables.item.some(item => item.item_title === 'PERSON_REQUEST_INVALID_SPEC'), false, 'the native CLI refuses unknown specs before an ordinary add move');
  const refused = await waitForRequest(chrome, link.board, invalid.result.request.id, 'refused');
  const refusal = refused.state.personRequests.find(entry => entry.id === invalid.result.request.id).error;
  assert.equal(refusal.code, 'UNKNOWN_SPEC');
  assert.equal(refusal.message, 'G999 is not in SPEC.md');
  const terminalRefusal = await box.cliLocal('add', box.lane, 'PERSON_REQUEST_INVALID_SPEC', '--specs', 'G999');
  assert.equal(terminalRefusal.code, 1);
  assert.deepEqual(refusal, terminalRefusal.document.error, 'the request carries the same complete CLI refusal document');
  const local = (await box.cliLocal('export')).document;
  assert.equal(local.tables.item.some(item => item.item_title === 'PERSON_REQUEST_INVALID_SPEC'), false);
  assert.equal(local.tables.event.some(event => event.event_kind === 'row_decision' && JSON.parse(event.event_detail).record.id === 'G999'), false);
  box.assertCliChildrenComplete();
});

