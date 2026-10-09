/** Machine execution can fulfil only an earlier phone's literal intent on every replica [H12,H16,B26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { appliedSequence, applyRelayMove, prepareEngineMove } from '../src/engine.js';
import { preparePersonRequest } from '../src/person-request.js';
import { personRequestRecords, receivePersonRequest, requestIntentDigest, requestStageText } from '../src/relay-requests.js';

const at = '2026-10-09T21:00:00.000Z';
const phone = { kind: 'person', userId: 'private-person' };
const machine = { kind: 'machine', userId: 'private-person', machine: 'private-machine' };

/** Keep two real SQLite replicas at the same ordered prefix and compare all replay outcomes. */
function replicas(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-machine-receipts-'));
  const boards = ['first', 'second'].map(name => {
    const board = store.openBoard(join(directory, name + '.sqlite'), { now: () => new Date(at) });
    store.ensureCoordinator(board, '/private/coordinator');
    return board;
  });
  t.after(() => { for (const board of boards) store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  return {
    boards,
    /** Deliver the same authenticated phone document to both durable replicas. */
    intake(document, sender = phone) {
      return boards.map(board => receivePersonRequest(board, document, { sequence: appliedSequence(board) + 1, at, sender }));
    },
    /** Apply one machine move in order and require equal authorization outcomes. */
    apply(move) {
      const outcomes = boards.map(board => applyRelayMove(board, move, { sequence: appliedSequence(board) + 1, at, sender: machine, kind: 'move' }));
      assert.deepEqual(outcomes[0], outcomes[1], 'independent replicas reach the same authorization result');
      return outcomes[0];
    },
  };
}

/** Build the exact fixed stage receipt using the authenticated request's digest. */
function stage(board, document, phase = 'claim') {
  const record = personRequestRecords(board).find(row => row.id === document.id);
  const move = prepareEngineMove(board, 'shout', [{ from: 'person', to: 'coordinator', text: requestStageText(record, phase), lanes: [], ...(phase === 'repo-request' ? { request: true } : {}) }]);
  move.personRequest = { id: document.id, executor: 'private-executor', phase, digest: requestIntentDigest(record) };
  return move;
}

/** Attach the earlier request binding to a new ordinary executable move. */
function execution(board, document, operation, args) {
  const move = prepareEngineMove(board, operation, args);
  move.personRequest = { ...stage(board, document).personRequest, phase: 'execute' };
  return move;
}

test('machine receipts cannot invent, alter, redirect or repeat a phone action on two replicas [H12,H16,B26]', t => {
  const box = replicas(t);
  const board = box.boards[0];
  const document = preparePersonRequest({ verb: 'shout', args: { to: 'coordinator', text: 'Phone approved this literal text' } }, 'phone-intent');
  const absent = prepareEngineMove(board, 'shout', [{ from: 'person', to: 'coordinator', text: 'invented person text', lanes: [] }]);
  assert.equal(box.apply(absent).error?.code, 'RELAY_PERSON_ONLY');
  absent.id = 'missing-request'; absent.personRequest = { id: document.id, executor: 'private-executor', phase: 'execute', digest: '0'.repeat(64) };
  assert.equal(box.apply(absent).error?.code, 'RELAY_PERSON_ONLY');
  box.intake(document);
  const badDigest = stage(board, document); badDigest.personRequest.digest = '0'.repeat(64);
  assert.equal(box.apply(badDigest).error?.code, 'RELAY_PERSON_ONLY');
  const extraText = stage(board, document); extraText.args[0].text += ' unrelated person instruction';
  assert.equal(box.apply(extraText).error?.code, 'RELAY_PERSON_ONLY');
  const decisionFlag = stage(board, document); decisionFlag.args[0].decision = true;
  assert.equal(box.apply(decisionFlag).error?.code, 'RELAY_PERSON_ONLY');
  const requestFlag = stage(board, document); requestFlag.args[0].request = true;
  assert.equal(box.apply(requestFlag).error?.code, 'RELAY_PERSON_ONLY');
  assert.ok(box.apply(stage(board, document)).result);
  for (const change of [{ text: 'different literal text' }, { to: 'all' }, { decision: true }, { request: true }]) {
    const move = execution(board, document, 'shout', [{ from: 'person', to: 'coordinator', text: document.move.args.text, lanes: [], ...change }]);
    assert.equal(box.apply(move).error?.code, 'RELAY_PERSON_ONLY', 'a valid digest never authorizes changed intent');
  }
  assert.ok(box.apply(execution(board, document, 'shout', [{ from: 'person', to: 'coordinator', text: document.move.args.text, lanes: [] }])).result);
  assert.equal(box.apply(execution(board, document, 'shout', [{ from: 'person', to: 'coordinator', text: document.move.args.text, lanes: [] }])).error?.code, 'RELAY_PERSON_ONLY');
  for (const replica of box.boards) assert.equal(replica.db.prepare('SELECT count(*) AS n FROM shout WHERE shout_text=?').get(document.move.args.text).n, 1);
  const refusal = preparePersonRequest({ verb: 'shout', args: { to: 'coordinator', text: 'Phone intent that may be refused' } }, 'refusal-intent');
  box.intake(refusal);
  assert.ok(box.apply(stage(board, refusal)).result);
  const forgedRefusal = stage(board, refusal, 'refuse');
  forgedRefusal.personRequest.error = { code: 'CHECK_FAILED', message: 'unrelated person instruction', next: 'retry the original intent' };
  forgedRefusal.args[0].text = 'View request ' + refusal.id + ': [CHECK_FAILED] unrelated person instruction';
  assert.equal(box.apply(forgedRefusal).error?.code, 'RELAY_PERSON_ONLY', 'dynamic refusal details cannot authorize unrelated person shout text');
  const fixedRefusal = stage(board, refusal, 'refuse');
  fixedRefusal.personRequest.error = forgedRefusal.personRequest.error;
  assert.ok(box.apply(fixedRefusal).result, 'the fixed refusal receipt preserves structured CLI error details');
  for (const replica of box.boards) {
    assert.deepEqual(personRequestRecords(replica).find(record => record.id === refusal.id).error, fixedRefusal.personRequest.error);
    assert.equal(replica.db.prepare('SELECT count(*) AS n FROM shout WHERE shout_text=?').get(forgedRefusal.args[0].text).n, 0);
  }

});

test('a waiting row decision has one machine execution and one fixed coordinator request [H12,H16,B26]', t => {
  const box = replicas(t);
  const board = box.boards[0];
  const document = preparePersonRequest({ verb: 'spec-approve', args: { ids: 'G1', text: 'A precise phone choice' } }, 'row-intent');
  box.intake(document);
  assert.ok(box.apply(stage(board, document)).result);
  const row = { kind: 'spec', id: 'G1', file: 'SPEC.md', source: '- G1 [draft, must] A precise phone choice | gate: review',
    replacement: '- G1 [approved, must] A precise phone choice | gate: review', text: 'A precise phone choice', decision: 'approve', by: 'person' };
  const wrong = execution(board, document, 'recordRowDecisions', [{ agentId: 'person', channel: 'view', decisions: [{ ...row, id: 'G2' }] }]);
  assert.equal(box.apply(wrong).error?.code, 'RELAY_PERSON_ONLY');
  const approved = execution(board, document, 'recordRowDecisions', [{ agentId: 'person', channel: 'view', decisions: [row] }]);
  const result = box.apply(approved);
  assert.ok(result.result, 'the genuine phone row choice is recorded');
  assert.equal(personRequestRecords(board).find(record => record.id === document.id).status, 'waiting');
  assert.equal(box.apply(execution(board, document, 'recordRowDecisions', [{ agentId: 'person', channel: 'view', decisions: [row] }])).error?.code, 'RELAY_PERSON_ONLY', 'waiting for repository application cannot authorize a second approval');
  assert.ok(box.apply(stage(board, document, 'repo-request')).result);
  assert.equal(box.apply(stage(board, document, 'repo-request')).error?.code, 'RELAY_PERSON_ONLY');
  for (const replica of box.boards) assert.equal(store.rowDecisions(replica).length, 1);
});
