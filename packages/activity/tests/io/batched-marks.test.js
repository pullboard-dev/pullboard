/** With inbox.batchedMarks on, inbox delivery enqueues its marks and hands delivery records off, writing nothing inline; off, it writes as before [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { register } from '../../../store/index.js';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
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

/** setup() plus one fresh interrupt (a claim lapsing within minutes), and ports that count which write paths a read takes. */
function interruptSetup(t, { batchedMarks, handOffDelivery = true, readBoard = true }) {
  const made = setup(t, batchedMarks);
  const { board, agent, ports } = made;
  const item = cellItem(board, { lane: 'web', title: 'Lapsing claim', criterion: 'The page renders.', specIds: ['G1'] }).item_id;
  store.claim(board, item, { agentId: agent, lane: 'web', leaseMs: 60_000, freeze: () => ({ text: '{"rows":[]}', digest: 'd'.repeat(64) }) });
  const used = { withBoard: 0, withBoardRead: 0, handedDelivery: [], handedMarks: [] };
  const counted = {
    ...ports,
    withBoard: async (c, fn) => { used.withBoard += 1; return ports.withBoard(c, fn); },
    ...(readBoard ? { withBoardRead: async (c, fn) => { used.withBoardRead += 1; return fn(board); } } : {}),
    ...(handOffDelivery ? { handOffDelivery: (c, agentId, group) => { used.handedDelivery.push({ agentId, group }); } } : {}),
    handOffMarks: (c, marks) => { used.handedMarks.push(marks); },
  };
  return { ...made, ports: counted, used };
}

test('activity.inbox.batched-delivery-on: clause 1: with inbox.batchedMarks on, a read with one fresh interrupt and three unread shouts hands its delivery and mark off and opens no write board [C7]', async t => {
  const { board, agent, ctx, ports, used, calls } = interruptSetup(t, { batchedMarks: true });
  const result = await deliverActivity(ctx, {}, ports);
  assert.equal(used.withBoard, 0, 'no write board was opened');
  assert.equal(used.withBoardRead, 1, 'the read ran on the read board only');
  assert.deepEqual(calls, [], 'ordered was never called');
  assert.equal(used.handedDelivery.length, 1, 'the delivery group went to handOffDelivery');
  assert.equal(used.handedDelivery[0].agentId, agent);
  assert.equal(used.handedDelivery[0].group.interrupts.length, 1);
  assert.equal(used.handedMarks.length, 1, 'the shout mark went to handOffMarks');
  assert.equal(result.activity.interrupts.length, 1, 'the interrupt is still shown');
  assert.ok(result.shouts.length >= 3, 'every unread shout is still shown');
  assert.equal(mark(board, agent), 0, 'no mark was written inline');
});

test('activity.inbox.batched-delivery-off: clause 2: with the setting off or no handOffDelivery port, delivery records through ordered and the mark writes inline; acted ids still go through ordered [C7]', async t => {
  const off = interruptSetup(t, { batchedMarks: false });
  const first = await deliverActivity(off.ctx, {}, off.ports);
  assert.equal(off.used.handedDelivery.length, 0, 'the setting off never uses the port');
  assert.ok(off.calls.includes('recordActivityDelivery'), 'delivery recorded through ordered');
  assert.equal(off.used.withBoard, 1, 'the write board opened as on main');
  assert.equal(mark(off.board, off.agent), 3, 'the mark was written inline');
  const [interrupt] = first.activity.interrupts;
  await deliverActivity(off.ctx, { actedIds: [interrupt.id] }, off.ports);
  assert.ok(off.calls.includes('actOnActivity'), 'acted ids go through ordered actOnActivity');
  const bare = interruptSetup(t, { batchedMarks: true, handOffDelivery: false });
  await deliverActivity(bare.ctx, {}, bare.ports);
  assert.ok(bare.calls.includes('recordActivityDelivery'), 'a caller with no handOffDelivery records through ordered');
  assert.equal(bare.used.withBoard, 1);
});
