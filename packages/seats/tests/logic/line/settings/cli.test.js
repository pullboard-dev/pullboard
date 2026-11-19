/** @pullboard-test-input source-cell seats */
/** lineSettingsCommand accepts level.liveOnly, stores route.liveOnly, and prints level.liveOnly [C7,#10806]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineSettingsCommand } from '../../../../index.js';

const harness = () => {
  const said = [];
  const orders = [];
  const io = { say: line => said.push(line), result: () => {} };
  const cli = {
    actOn: (_io, fn) => fn({}, { db: { prepare: () => ({ all: () => [] }) } }, { id: 'core-1' }),
    context: () => ({}),
    withBoardRead: () => ({ 'route.liveOnly': true, 'review.capacity': 2 }),
    ordered: async (_ctx, _board, move, args) => { orders.push({ move, args }); return {}; },
  };
  return { io, cli, said, orders };
};

test('seats.logic-line-settings-cli.level-name-stores-route-key: clause 1: level.liveOnly and route.liveOnly both order setLineSetting with key route.liveOnly [C7,#10806]', async () => {
  for (const name of ['level.liveOnly', 'route.liveOnly']) {
    const { io, cli, orders } = harness();
    await lineSettingsCommand(io, { second: name, rest: ['on'], values: { reason: 'why', window: '{"windowMinutes":60}' } }, cli);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].move, 'setLineSetting');
    assert.equal(orders[0].args[0].key, 'route.liveOnly');
    assert.equal(orders[0].args[0].value, true);
  }
});

test('seats.logic-line-settings-cli.list-shows-level-name: clause 2: the list and the confirmation print level.liveOnly, never route.liveOnly [C7,#10806]', async () => {
  const list = harness();
  lineSettingsCommand(list.io, { second: undefined, rest: [], values: {} }, list.cli);
  assert.ok(list.said.includes('level.liveOnly: true'));
  assert.ok(!list.said.some(line => line.includes('route.liveOnly')));
  const set = harness();
  await lineSettingsCommand(set.io, { second: 'level.liveOnly', rest: ['off'], values: { window: '{"windowMinutes":60}' } }, set.cli);
  assert.deepEqual(set.said, ['level.liveOnly: off; recorded on this board']);
});
