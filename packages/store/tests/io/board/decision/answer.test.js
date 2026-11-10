/** Decision queue, claim retention and person boundary, on a real SQLite board [B7,B21,B26,B27]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../../../index.js';
import { exportBoard } from '../../../../index.js';
import { importBoard } from '../../../../index.js';
import { applyEngineMove } from '../../../../../state/index.js';
import { prepareEngineMove } from '../../../../../state/index.js';
import { DECISION_QUEUE_ENGINE } from '../../../../../state/light.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellItem } from '../../../fixtures/cell.js';
import { cellSeat } from '../../../fixtures/cell.js';
import { openCellBoard } from '../../../fixtures/cell.js';
import { closeCellBoard } from '../../../fixtures/cell.js';

const LANES = ['coordinator', 'web'];

test('a decision asked on an item is answered from the queue and recorded on the item [B7,B21,B26,B27]', (t) => {
  const board = cellBoard(t, ':memory:');
  cellSeat(board, { lane: 'coordinator', path: '/decision-root' });
  const builder = cellSeat(board, { lane: 'web', path: '/decision-root/web-1' }).id;
  const item = cellItem(board, { lane: 'web', title: 'Keep building while a choice is pending', criterion: 'The page renders.', specIds: ['G1'] }).item_id;
  store.claim(board, item, { agentId: builder, lane: 'web', leaseMs: 7_200_000, freeze: () => ({ text: '{"rows":[]}', digest: 'd'.repeat(64) }) });
  const before = store.getItem(board, item);
  const options = ['Keep the local interface', 'Use the shared interface'];
  const question = 'Which interface should this item expose?';
  const ask = store.shout(board, { from: builder, to: 'coordinator', item, text: question, decision: true, options, lanes: LANES });
  const pending = store.getItem(board, item);
  assert.equal(pending.item_status, 'claimed');
  assert.equal(pending.item_owner, before.item_owner);
  assert.equal(pending.item_lease_until, before.item_lease_until, 'asking neither releases nor renews the claim');
  const ordinary = store.shout(board, { from: builder, to: 'all', text: 'Implementation continues while the answer is pending.', lanes: LANES });
  const queue = store.openDecisions(board, 'coordinator');
  const queued = queue.find(row => row.shout_id === ask);
  assert.ok(queued, 'the coordinator has a separate open decision queue');
  assert.deepEqual(queued.options, options);
  assert.equal(queued.item, item);
  assert.equal(queue.some(row => row.shout_id === ordinary), false);
  assert.ok(store.allShouts(board).some(row => row.shout_id === ordinary), 'ordinary shouts remain in the stream');
  const answer = store.answerDecision(board, ask, { agentId: 'coordinator', text: options[1], lanes: LANES });
  assert.equal(store.openDecisions(board, 'coordinator').some(row => row.shout_id === ask), false);
  const answered = store.getItem(board, item);
  assert.ok(store.itemThread(board, item).some(row => row.kind === 'answer' && row.detail.text === options[1]),
    'the durable item thread holds the answer');
  assert.ok(store.inbox(board, builder).some(row => row.shout_id === answer && row.shout_text === options[1]));
  assert.equal(answered.item_status, 'claimed');
  assert.equal(answered.item_owner, before.item_owner);
  assert.equal(answered.item_lease_until, before.item_lease_until);
  assert.throws(() => store.answerDecision(board, ask, { agentId: 'coordinator', text: options[0], lanes: LANES }), { code: 'ALREADY_ANSWERED' });
  const personal = store.shout(board, { from: builder, to: 'coordinator', item, text: 'May the public policy change?', decision: true, options: ['Approve', 'Decline'], lanes: LANES });
  const passed = store.passDecision(board, personal, { agentId: 'coordinator', note: 'Only the person can approve policy.', lanes: LANES });
  assert.ok(store.openDecisions(board, store.PERSON).some(row => row.shout_id === passed), 'the passed decision waits on the person');
  assert.throws(() => store.answerDecision(board, passed, { agentId: 'coordinator', text: 'Approve', lanes: LANES }), { code: 'B26_PERSON_ANSWER' });
  assert.ok(store.openDecisions(board, store.PERSON).some(row => row.shout_id === passed),
    'the coordinator cannot clear a person-only choice');
  store.answerDecision(board, passed, { agentId: 'coordinator', asPerson: true, text: 'Decline', lanes: LANES });
  assert.equal(store.openDecisions(board, store.PERSON).some(row => row.shout_id === passed), false);
  assert.ok(store.inbox(board, builder).some(row => /Person answered/.test(row.shout_text)));
});

test('item decision options replay exactly and never acquire legacy engine authority [B21,H3,H16]', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-decision-queue-'));
  const source = openCellBoard(join(directory, 'source.sqlite'));
  const replica = openCellBoard(join(directory, 'replica.sqlite'));
  const restored = openCellBoard(join(directory, 'restored.sqlite'));
  t.after(() => {
    for (const board of [source, replica, restored]) closeCellBoard(board);
    rmSync(directory, { recursive: true, force: true });
  });
  store.register(source, { lane: 'coordinator', path: '/decision-root' });
  store.register(source, { lane: 'web', path: '/decision-root/web-1' });
  store.register(source, { lane: 'web', path: '/decision-root/web-2' });
  const id = store.addItem(source, { by: 'coordinator', lane: 'web', title: 'Replica choice' });
  store.claim(source, id, { agentId: 'web-1', lane: 'web', leaseMs: 7_200_000,
    freeze: () => ({ text: '{"rows":[]}', digest: 'd'.repeat(64) }) });
  importBoard(replica, exportBoard(source));
  const message = { from: 'web-1', to: 'coordinator', item: id, text: 'Which shape?', decision: true,
    options: ['Small', 'Shared'], lanes: ['coordinator', 'web'] };
  const move = prepareEngineMove(source, 'shout', [message], { id: 'item-decision', actor: 'web-1' });
  const at = new Date().toISOString();
  assert.throws(() => applyEngineMove(replica, { ...move, engine: DECISION_QUEUE_ENGINE - 1 }, { sequence: 1, at }), /RELAY_MOVE/);
  assert.deepEqual(store.openDecisions(replica), [], 'a legacy engine cannot silently discard the options');
  const answer = applyEngineMove(replica, move, { sequence: 1, at });
  assert.ok(answer);
  assert.deepEqual(store.openDecisions(replica, 'coordinator').map(row => ({ item: row.item, options: row.options })),
    [{ item: id, options: ['Small', 'Shared'] }]);
  importBoard(restored, exportBoard(replica));
  assert.deepEqual(store.openDecisions(restored), store.openDecisions(replica), 'snapshot restores the exact pending choices');
  const before = store.events(replica).length;
  for (const options of [[], ['Only'], ['Same', 'Same'], ['A', ' '], 'not an array']) {
    assert.throws(() => store.shout(replica, { ...message, options }), /BAD_DECISION_OPTIONS/);
  }
  assert.throws(() => store.shout(replica, { ...message, from: 'web-2' }), /NOT_YOUR_ITEM_DECISION/);
  assert.equal(store.events(replica).length, before, 'refused choices append no successful decision');
  const legacy = prepareEngineMove(replica, 'shout', [{ from: 'web-1', to: 'coordinator', text: 'Old question',
    decision: true, lanes: ['coordinator', 'web'] }], { id: 'legacy-decision', actor: 'web-1' });
  applyEngineMove(replica, { ...legacy, engine: 1 }, { sequence: 2, at });
  assert.equal(store.openDecisions(replica).find(row => row.shout_text === 'Old question').options, undefined);
  const opaque = prepareEngineMove(replica, 'shout', [{ from: 'web-2', to: 'coordinator', text: 'Legacy opaque detail',
    decision: true, lanes: ['coordinator', 'web'], detail: { item: id, decisionOptions: ['Injected A', 'Injected B'] } }],
  { id: 'legacy-opaque-detail', actor: 'web-2' });
  applyEngineMove(replica, { ...opaque, engine: 1 }, { sequence: 3, at });
  const legacyOpaque = store.openDecisions(replica).find(row => row.shout_text === 'Legacy opaque detail');
  assert.equal(legacyOpaque.options, undefined, 'old opaque detail must not acquire new option meaning or item authority');
  assert.equal(replica.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`item_decision:${legacyOpaque.shout_id}`),
    undefined, 'legacy engine data creates no new decision index');
  assert.deepEqual(JSON.parse(store.events(replica).at(-1).event_detail).decisionOptions, ['Injected A', 'Injected B'],
    'the legacy opaque event data itself is retained without rewriting history');
});
