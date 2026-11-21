/** Routing capacity counts the ready items per route from the same ready list it counts in total [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routingCapacity } from '../../src/logic/capacity.js';

/** A board whose open items sit in the given routes, with no waits, holds or collisions. */
function world(routes, nextEligible) {
  const items = routes.map((item_route, index) => ({ item_id: index + 1, item_status: 'open', item_lane: 'core', item_route }));
  const reads = {
    ...(nextEligible ? { nextEligible } : {}),
    lineSettings: () => ({ 'route.liveOnly': false }),
    withLocalSeatPresence: () => [{ agent_id: 'core-1', presence: 'live' }],
    listItems: () => items,
    laneHolds: () => [],
    laneHold: () => null,
    localDependencyIds: () => [],
    itemById: () => null,
    dependencyLabel: String,
    itemFileCollisions: () => [],
  };
  return routingCapacity({}, [], () => [], reads);
}

test('queue.logic-capacity.ready-by-route: routingCapacity returns readyByRoute, the ready item count per route, summing to readyItems and zero for a route with none [C7]', () => {
  const mixed = world(['mid', 'strong', 'mid', 'mid']);
  assert.deepEqual(mixed.readyByRoute, { mid: 3, strong: 1 });
  assert.equal(mixed.readyByRoute.mid + mixed.readyByRoute.strong, mixed.readyItems);
  const onlyStrong = world(['strong', 'strong']);
  assert.deepEqual(onlyStrong.readyByRoute, { mid: 0, strong: 2 });
  assert.equal(onlyStrong.readyItems, 2);
  assert.deepEqual(world([]).readyByRoute, { mid: 0, strong: 0 });
});

test('queue.logic-capacity.ready-by-route-real-path: the readyByRoute of routingCapacity comes from the same ready list as readyItems and keeps every existing field [C7]', () => {
  const capacity = world(['mid', 'strong']);
  assert.equal(capacity.readyItems, 2);
  assert.equal(capacity.liveAgents, 1);
  assert.equal(capacity.idleAgents, 0);
  assert.equal(capacity.liveOnly, false);
});

test('queue.logic-capacity.ready-by-route-uses-next-eligibility: routingCapacity counts readyByRoute and readyItems only for items the nextEligible port answers null for a seat of that route [C7]', () => {
  const answers = new Map([[2, { code: 'ITEM_HELD' }], [3, { code: 'ROUTE_FILTER' }]]);
  const seen = [];
  const capacity = world(['mid', 'mid', 'strong', 'strong'], (board, item, route) => { seen.push([item.item_id, route]); return answers.get(item.item_id) ?? null; });
  assert.deepEqual(capacity.readyByRoute, { mid: 1, strong: 1 });
  assert.equal(capacity.readyItems, 2);
  assert.deepEqual(seen, [[1, 'mid'], [2, 'mid'], [3, 'strong'], [4, 'strong']]);
});

test('queue.logic-capacity.no-port-unchanged: without a nextEligible port the counts equal the unfiltered ready list [C7]', () => {
  const capacity = world(['mid', 'strong', 'strong']);
  assert.deepEqual(capacity.readyByRoute, { mid: 1, strong: 2 });
  assert.equal(capacity.readyItems, 3);
});
