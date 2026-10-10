/** Durable relay intake and tagged coordinator outcomes use real SQLite receipts [H12,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { COORDINATOR } from '../src/config.js';
import { appliedSequence, applyEngineMove, engineReceipt, prepareEngineMove } from '../src/engine.js';
import { refusalDocument } from '../src/json.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { preparePersonRequest } from '../src/person-request.js';
import { Refused } from '../src/refused.js';
import { personRequestRecords, personRequestStatuses, receivePersonRequest, requestIntentDigest, requestStageText } from '../src/relay-requests.js';

const at = '2026-10-08T12:34:56.000Z';
const person = { kind: 'person', userId: 'github-person-1' };

/** Give each test a real, reopenable SQLite board and remove all side files afterward. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-person-request-receipts-'));
  const file = join(directory, 'board.sqlite');
  let board = store.openBoard(file);
  store.register(board, { lane: COORDINATOR, path: join(directory, 'coordinator') });
  t.after(() => {
    try { store.closeBoard(board); } catch { /* A test may have closed before its final reopen. */ }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get board() { return board; },
    reopen() { store.closeBoard(board); board = store.openBoard(file); return board; },
  };
}

/** Build a stable, versioned request in the exact form emitted by the paired browser. */
function request(id, title = 'Requested change') {
  return preparePersonRequest({ verb: 'add', args: { lane: 'web', title } }, id);
}

/** Build the ordinary engine move used to claim a request on the coordinator device. */
function claimMove(board, id, executor, moveId = 'claim-stage') {
  const move = prepareEngineMove(board, 'shout', [{
    from: 'person', to: 'coordinator', text: 'View request ' + id + ': Received a request from the paired view.', lanes: [],
  }], { id: moveId });
  const record = personRequestRecords(board).find(entry => entry.id === id && !entry.duplicateOf);
  move.personRequest = { id, executor, phase: 'claim', digest: requestIntentDigest(record) };
  return move;
}

test('[H12,H16] intake advances atomically and survives reopen, duplicates, and malformed senders', t => {
  const box = fixture(t);
  const initial = request('retry-1');
  assert.equal(receivePersonRequest(box.board, initial, { sequence: 1, at, sender: person }).status, 'waiting');
  assert.equal(appliedSequence(box.board), 1);

  const board = box.reopen();
  assert.throws(() => receivePersonRequest(board, request('retry-1', 'Changed earlier position'), { sequence: 1, at, sender: person }), error => error.code === 'RELAY_CURSOR');
  assert.equal(appliedSequence(board), 1, 'the replay cursor survives closing and reopening SQLite');
  const duplicate = receivePersonRequest(board, initial, { sequence: 2, at, sender: person });
  assert.equal(duplicate.duplicateOf, 1, 'the retry keeps the original request receipt');
  assert.equal(personRequestRecords(board).filter(record => !record.duplicateOf).length, 1);

  const changed = receivePersonRequest(board, request('retry-1', 'Changed intent'), { sequence: 3, at, sender: person });
  assert.equal(changed.status, 'refused');
  assert.equal(changed.error.code, 'PERSON_REQUEST_ID');

  const malformed = receivePersonRequest(board, {
    version: 1, type: 'person-request', id: 'engine-shaped',
    move: { operation: 'addItem', args: [{ by: 'coordinator', lane: 'web', title: 'Must not execute' }] },
  }, { sequence: 4, at, sender: person });
  assert.equal(malformed.status, 'refused');
  assert.equal(malformed.error.code, 'BAD_REQUEST');
  assert.deepEqual(store.listItems(board, { all: true }), [], 'an engine-shaped request never becomes a board action');

  const agentRequest = receivePersonRequest(board, request('agent-1'), {
    sequence: 5, at, sender: { kind: 'agent', userId: 'github-person-1', agent: 'remote-1' },
  });
  assert.equal(agentRequest.status, 'refused');
  assert.equal(agentRequest.error.code, 'RELAY_PERSON_ONLY');

  const before = personRequestRecords(board);
  assert.throws(() => receivePersonRequest(board, request('gap-1'), { sequence: 7, at, sender: person }),
    error => error instanceof Refused && error.code === 'RELAY_ORDER');
  assert.equal(appliedSequence(board), 5, 'a missing prefix cannot move the durable cursor');
  assert.deepEqual(personRequestRecords(board), before, 'a refused gap writes no partial request receipt');

  const reopened = box.reopen();
  assert.equal(appliedSequence(reopened), 5);
  assert.deepEqual(personRequestStatuses(reopened).map(record => record.status), ['waiting', 'refused', 'refused', 'refused']);
});

test('[H12,H16] elected executor commits one ordinary engine move and replay returns its receipt', t => {
  const box = fixture(t);
  const board = box.board;
  const document = preparePersonRequest({ verb: 'shout', args: { to: 'coordinator', text: 'Please review this' } }, 'shout-1');
  receivePersonRequest(board, document, { sequence: 1, at, sender: person });
  const digest = requestIntentDigest(personRequestRecords(board).find(record => record.id === document.id));

  const claim = claimMove(board, document.id, 'device-a');
  assert.equal(claim.engine, ENGINE_VERSION);
  const claimed = applyEngineMove(board, claim, { sequence: 2, at });
  assert.ok(claimed.result);
  assert.equal(personRequestRecords(board)[0].executor, 'device-a');

  const badId = prepareEngineMove(board, 'shout', [{ from: 'person', to: 'coordinator', text: 'wrong request', lanes: [] }], { id: 'bad-request-id' });
  badId.personRequest = { id: 'missing-request', executor: 'device-a', phase: 'execute', digest };
  assert.equal(applyEngineMove(board, badId, { sequence: 3, at }).error?.code, 'PERSON_REQUEST_CLOSED');
  const wrongOperation = prepareEngineMove(board, 'addItem', [{ by: 'person', lane: 'web', title: 'Wrong action' }], { id: 'wrong-operation' });
  wrongOperation.personRequest = { id: document.id, executor: 'device-a', phase: 'execute', digest };
  assert.equal(applyEngineMove(board, wrongOperation, { sequence: 4, at }).error?.code, 'PERSON_REQUEST_RECEIPT');

  const wrongArguments = prepareEngineMove(board, 'shout', [{ from: 'person', to: 'coordinator', text: 'A different question', lanes: [] }], { id: 'wrong-arguments' });
  wrongArguments.personRequest = { id: document.id, executor: 'device-a', phase: 'execute', digest };
  assert.equal(applyEngineMove(board, wrongArguments, { sequence: 5, at }).error?.code, 'PERSON_REQUEST_RECEIPT', 'an ordinary move must fulfil the exact queued intent');

  const losingClaim = claimMove(board, document.id, 'device-b', 'claim-stage-other');
  const lost = applyEngineMove(board, losingClaim, { sequence: 6, at });
  assert.equal(lost.error.code, 'PERSON_REQUEST_TAKEN');
  assert.equal(personRequestRecords(board)[0].executor, 'device-a', 'a later device cannot replace the elected executor');

  const execution = prepareEngineMove(board, 'shout', [{
    from: 'person', to: 'coordinator', text: 'Please review this', lanes: [],
  }], { id: 'execute-shout-1' });
  execution.personRequest = { id: document.id, executor: 'device-a', phase: 'execute', digest };
  assert.equal(execution.engine, ENGINE_VERSION);
  const result = applyEngineMove(board, execution, { sequence: 7, at });
  assert.ok(result.result);
  assert.equal(personRequestStatuses(board)[0].status, 'done');
  const count = board.db.prepare("SELECT COUNT(*) AS count FROM shout WHERE shout_text='Please review this'").get().count;
  assert.equal(count, 1);

  const replayed = applyEngineMove(board, execution, { sequence: 7, at });
  assert.deepEqual(replayed, result, 'the same sequence and move ID return the committed outcome');
  assert.deepEqual(engineReceipt(board, execution.id).outcome, result);
  assert.equal(board.db.prepare("SELECT COUNT(*) AS count FROM shout WHERE shout_text='Please review this'").get().count, 1,
    'replay cannot create a second result');

  const reopened = box.reopen();
  assert.equal(personRequestStatuses(reopened)[0].status, 'done');
  assert.equal(appliedSequence(reopened), 7);
});

test('[H12,H16] native CLI refusal fields remain attached to the durable request receipt', t => {
  const box = fixture(t);
  const board = box.board;
  const document = request('refused-1', 'A row that is no longer valid');
  receivePersonRequest(board, document, { sequence: 1, at, sender: person });
  applyEngineMove(board, claimMove(board, document.id, 'device-a'), { sequence: 2, at });

  const cliError = refusalDocument(new Refused('UNKNOWN_SPEC', 'G999 is not in SPEC.md')).error;
  const refusal = prepareEngineMove(board, 'shout', [{
    from: 'person', to: 'coordinator', text: requestStageText(personRequestRecords(board).find(record => record.id === document.id), 'refuse'), lanes: [],
  }], { id: 'refusal-stage' });
  refusal.personRequest = { id: document.id, executor: 'device-a', phase: 'refuse', digest: requestIntentDigest(personRequestRecords(board).find(record => record.id === document.id)), error: cliError };
  assert.equal(refusal.engine, ENGINE_VERSION);
  const outcome = applyEngineMove(board, refusal, { sequence: 3, at });
  assert.ok(outcome.result);

  const saved = personRequestStatuses(board)[0];
  assert.equal(saved.status, 'refused');
  assert.deepEqual(saved.error, cliError, 'code, user-facing explanation, and next step stay intact');
  assert.equal(saved.error.code, 'UNKNOWN_SPEC');
  assert.match(saved.error.message, /G999 is not in SPEC\.md/);
  assert.ok(saved.error.next);

  const reopened = box.reopen();
  assert.deepEqual(personRequestStatuses(reopened)[0].error, cliError);
  assert.equal(appliedSequence(reopened), 3);
});
