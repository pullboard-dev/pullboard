/** With inbox.batchedMarks on, inbox delivery enqueues its marks and writes none inline; off, it writes as before [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { register } from '../../../store/index.js';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { deliverActivity } from '../../index.js';
import { describeSetting } from '../../../config/index.js';

const mark = (board, agentId) => board.db.prepare('SELECT agent_last_shout_id AS m FROM agent WHERE agent_id=?').get(agentId).m;

/** One seat with three shouts waiting, and the ports deliverActivity needs over that board. */
function setup(t, batchedMarks) {
  const board = cellBoard(t, ':memory:');
  register(board, { lane: 'coordinator', path: '/m/root' });
  const agent = register(board, { lane: 'web', path: '/m/a' });
  for (let i = 0; i < 3; i++) store.shout(board, { from: 'coordinator', to: 'all', text: `shout ${i}` });
  const ctx = { info: { root: cellRepo(t, { real: true }).root }, config: { inbox: { tokenBudget: 8192, batchedMarks }, spec: 'SPEC.md', practice: 'DOCTRINE.md' }, io: { err() {} } };
  const calls = [];
  const ports = {
    agentDisplayName: (agents, config, id) => id, evidenceLine: () => '',
    whoAmI: () => ({ id: agent }),
    withBoard: async (c, fn) => fn(board),
    ordered: async (c, b, name, args) => { calls.push(name); return store[name](b, ...args); },
  };
  return { board, agent, ctx, ports, calls };
}

test('activity.inbox.batched-marks-on: clause 1: with inbox.batchedMarks on, delivery enqueues the inbox mark and writes none inline [C7]', async t => {
  const { board, agent, ctx, ports } = setup(t, true);
  const result = await deliverActivity(ctx, {}, ports);
  assert.ok(result.shouts.length >= 3, 'the read still shows every waiting shout');
  assert.equal(mark(board, agent), 0, 'no mark was written inline');
  assert.equal(store.flushInboxMarks(board), 1, 'the mark waits in the queue');
  assert.equal(mark(board, agent), 3, 'the flush records the highest shout shown');
});

test('activity.inbox.batched-marks-off: clause 2: with inbox.batchedMarks off, delivery writes the mark as on main, and the setting is described [C7]', async t => {
  const { board, agent, ctx, ports } = setup(t, false);
  await deliverActivity(ctx, {}, ports);
  assert.equal(mark(board, agent), 3, 'the mark is written inline');
  assert.equal(store.flushInboxMarks(board), 0, 'nothing was queued');
  const described = describeSetting('inbox.batchedMarks');
  assert.ok(described?.description && described.label, 'inbox.batchedMarks is a described setting');
});
