/** The unblock planner weighs builder capacity against buildable items and ranks root blockers by items unblocked [C7,B8]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unblockPlan } from '../../src/logic/unblock.js';

const item = (id, extra = {}) => ({ id, status: 'open', route: 'core', after: [], ...extra });

/** Items 1-3 wait on epic 10, held as a parent; its one open child 11 waits on 12, a claim with no sign of life. */
const FIXTURE = {
  items: [item(1, { after: [10] }), item(2, { after: [10] }), item(3, { after: [10] }), item(10), item(11, { parent: 10, after: [12] }), item(12, { status: 'claimed' }), item(20), item(21, { gateAtHead: true }), item(22, { rescoped: ['core'] })],
  holds: [{ item: 10, kind: 'parent' }],
  claims: [{ item: 12, dead: true }],
  seats: [{ route: 'core', live: true }, { route: 'core', live: true }, { route: 'core', live: false }, { route: 'view', live: true }],
  gates: [],
};

test('cli.logic-unblock.capacity-and-roots: clause 1: capacity counts live builder seats per route, buildable skips held, waiting, gate-at-head and re-scoped items, and one dead claim is the single root of 5 stuck items [C7,B8]', () => {
  const plan = unblockPlan(FIXTURE);
  assert.deepEqual(plan.capacity, { core: 2, view: 1 });
  assert.deepEqual(plan.buildable, { core: 1 }, 'only item 20 is open, unheld, free of waits, not gate-at-head and not re-scoped');
  assert.equal(plan.stuck, 5);
  assert.equal(plan.roots.length, 1);
  assert.equal(plan.roots[0].id, 12);
  assert.equal(plan.roots[0].cause, 'dead-claim');
  assert.deepEqual(plan.roots[0].dependents, [1, 2, 3, 10, 11]);
});

test('cli.logic-unblock.ranked-actions: clause 2: roots group by cause, rank by items unblocked and each carries its clearing command [C7,B8]', () => {
  const rows = {
    items: [
      item(1, { after: [100] }), item(2, { after: [100] }), item(3, { after: [100] }),
      item(4, { after: [200] }), item(5, { after: [200] }),
      item(6, { after: [300] }), item(7, { after: [400] }), item(8, { after: [500] }), item(9, { after: [600] }),
      item(100, { gate: true }), item(200), item(300, { rescoped: ['core'] }), item(400, { folder: true }),
      item(500), item(501, { parent: 500 }), item(600),
    ],
    holds: [{ item: 200, kind: 'person' }, { item: 500, kind: 'parent' }],
    claims: [{ item: 400, dead: false }],
    gates: [{ item: 100, deferred: true, settled: false }],
  };
  const plan = unblockPlan(rows);
  const byId = Object.fromEntries(plan.roots.map(root => [root.id, root]));
  assert.deepEqual(plan.roots.map(root => root.weight), [...plan.roots.map(root => root.weight)].sort((a, b) => b - a), 'heaviest first');
  assert.equal(plan.roots[0].id, 100);
  assert.equal(byId[100].cause, 'unsettled-gate');
  assert.equal(byId[100].command, 'pullboard claim 100');
  assert.equal(byId[200].cause, 'hold-person');
  assert.equal(byId[200].command, 'pullboard hold 200 --off');
  assert.equal(byId[300].command, 'pullboard refreeze 300');
  assert.equal(byId[501].cause, 'free-open');
  assert.equal(byId[8], undefined, 'a held parent with an open child resolves to that child');
  assert.equal(byId[501].weight, 2, 'item 8 and the parent 500 both wait on the child');
  assert.equal(byId[600].command, 'pullboard claim 600');
  assert.equal(plan.causes['unsettled-gate'].items, 3);
  assert.equal(plan.causes['hold-person'].items, 3, 'items 4 and 5 plus the held item itself');
});
