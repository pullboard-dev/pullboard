/** Two coded claim releases leave a visible hold and one coordinator notice [C7,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../packages/store/index.js';
import { openBoard } from '../index.js';
import { RELEASE_TWICE_HOLD_ENGINE } from '../../../packages/state/light.js';
import { RELEASE_TWICE_ROUTE_ENGINE } from '../../../packages/state/light.js';

const commit = 'a'.repeat(40);
test('lib.hold.two-releases-hold-the-item-until-coordinator: two releases hold the item until coordinator lifts it [C7,H16]', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-release-twice-'));
  const board = openBoard(':memory:');
  t.after(() => { store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const first = store.register(board, { lane: 'core', path: '/one', route: 'strong' });
  const second = store.register(board, { lane: 'core', path: '/two', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'work', criterion: 'prove it', route: 'strong' });
  const claim = agentId => store.claim(board, id, { agentId, lane: 'core', leaseMs: 7200000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit, verify: { policy: 'any', family: 'off' } } }), digest: 'digest' }) });
  claim(first); store.release(board, id, first, '', 'INELIGIBLE');
  assert.equal(store.getItem(board, id).item_hold_reason, null);
  claim(second); store.release(board, id, second, '', 'BLOCKED');
  const held = store.getItem(board, id);
  assert.match(held.item_hold_reason, new RegExp(`${first}: INELIGIBLE`));
  assert.match(held.item_hold_reason, new RegExp(`${second}: BLOCKED`));
  assert.equal(store.recentShouts(board).filter(row => row.shout_text.includes(`#${id} held after two releases`)).length, 1);
  assert.notEqual(store.nextFor(board, { agentId: first, lane: 'core' }).item?.item_id, id);
  assert.throws(() => claim(first), error => error.code === 'ITEM_HELD');
  store.releaseItemHold(board, id, { agentId: 'coordinator' });
  claim(first); store.release(board, id, first, '', 'BLOCKED');
  assert.equal(store.getItem(board, id).item_hold_reason, null, 'lifting starts a new release episode');
  assert.equal(store.recentShouts(board).filter(row => row.shout_text.includes(`#${id} held after two releases`)).length, 1);
});

test('lib.hold.old-engine-releases-retain-their-pre-hold: old-engine releases retain their pre-hold behavior [C7,H16]', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-release-old-'));
  const board = openBoard(':memory:');
  t.after(() => { store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const first = store.register(board, { lane: 'core', path: '/one', route: 'strong' });
  const second = store.register(board, { lane: 'core', path: '/two', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'work', criterion: 'prove it', route: 'strong' });
  board.executionEngineVersion = RELEASE_TWICE_HOLD_ENGINE - 1;
  const claim = agentId => store.claim(board, id, { agentId, lane: 'core', leaseMs: 7200000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit, verify: { policy: 'any', family: 'off' } } }), digest: 'digest' }) });
  claim(first); store.release(board, id, first, '', 'INELIGIBLE');
  claim(second); store.release(board, id, second, '', 'BLOCKED');
  assert.equal(store.getItem(board, id).item_hold_reason, null);
  assert.equal(store.recentShouts(board).filter(row => row.shout_text.includes(`#${id} held after two releases`)).length, 0);
});

test('lib.hold.clean-next-claims-do-not-count-but: clean next claims do not count, but changed or explicit claims do [C7,H16]', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-release-auto-'));
  const board = openBoard(':memory:');
  t.after(() => { store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const first = store.register(board, { lane: 'core', path: '/one', route: 'strong' });
  const second = store.register(board, { lane: 'core', path: '/two', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'work', criterion: 'prove it', route: 'strong' });
  const claim = (agentId, auto = true) => store.claim(board, id, { agentId, lane: 'core', leaseMs: 7200000, head: commit,
    ...(auto ? { autoNext: true, autoNextSnapshot: { head: commit, digest: 'c'.repeat(64) } } : {}),
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit, verify: { policy: 'any', family: 'off' } } }), digest: 'digest' }) });
  claim(first); store.release(board, id, first, '', { worktreeSnapshot: { head: commit, digest: 'c'.repeat(64) } }, 'ROUTED_ELSEWHERE');
  claim(second); store.release(board, id, second, '', { worktreeSnapshot: { head: commit, digest: 'c'.repeat(64) } }, 'ROUTED_ELSEWHERE');
  assert.equal(store.getItem(board, id).item_hold_reason, null);
  claim(first); store.release(board, id, first, '', { worktreeSnapshot: { head: 'b'.repeat(40), digest: 'c'.repeat(64) } }, 'BLOCKED');
  assert.equal(store.getItem(board, id).item_hold_reason, null);
  claim(second, false); store.release(board, id, second, '', { worktreeSnapshot: { head: commit, digest: 'c'.repeat(64) } }, 'BLOCKED');
  assert.match(store.getItem(board, id).item_hold_reason, /Released twice/);
});

/** A board with a coordinator and two core seats on the given route, and one open item on that route. */
function routeBoard(t, route, prefix, seatRoute = route) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const board = openBoard(':memory:');
  t.after(() => { store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const first = store.register(board, { lane: 'core', path: '/one', route: seatRoute });
  const second = store.register(board, { lane: 'core', path: '/two', route: seatRoute });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'work', criterion: 'prove it', route: 'strong' });
  // Light and mid items need a diagnosis or brief to be filed; the route is what these tests exercise.
  board.db.prepare('UPDATE item SET item_route=? WHERE item_id=?').run(route, id);
  const claim = agentId => store.claim(board, id, { agentId, lane: 'core', leaseMs: 7200000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit, verify: { policy: 'any', family: 'off' } } }), digest: 'digest' }) });
  return { board, first, second, id, claim };
}

for (const [from, to] of [['light', 'mid'], ['mid', 'strong']]) {
  test(`clause 1: a second quality release moves a ${from} item up to ${to} with no hold [C7]`, t => {
    const { board, first, second, id, claim } = routeBoard(t, from, `pullboard-release-route-${from}-`, 'strong');
    claim(first); store.release(board, id, first, '', 'BLOCKED');
    assert.equal(store.getItem(board, id).item_route, from, 'one release leaves the route alone');
    claim(second); store.release(board, id, second, '', 'BLOCKED');
    const moved = store.getItem(board, id);
    assert.equal(moved.item_route, to);
    assert.equal(moved.item_status, 'open');
    assert.equal(moved.item_owner, null);
    assert.equal(moved.item_hold_reason, null);
    const escalations = board.db.prepare("SELECT event_by, event_detail FROM event WHERE item_id=? AND event_kind='escalate'").all(id);
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].event_by, 'coordinator');
    assert.deepEqual([JSON.parse(escalations[0].event_detail).from, JSON.parse(escalations[0].event_detail).to], [from, to]);
    assert.equal(store.recentShouts(board).filter(row => row.shout_text.includes('held after two releases')).length, 0);
  });
}

test('lib.hold.after-the-move-the-release-count-starts: after the move the release count starts over [C7]', t => {
  const { board, first, second, id, claim } = routeBoard(t, 'mid', 'pullboard-release-route-reset-', 'strong');
  claim(first); store.release(board, id, first, '', 'BLOCKED');
  claim(second); store.release(board, id, second, '', 'BLOCKED');
  assert.equal(store.getItem(board, id).item_route, 'strong');
  claim(first); store.release(board, id, first, '', 'BLOCKED');
  assert.equal(store.getItem(board, id).item_hold_reason, null, 'one release on the new route holds nothing');
  claim(second); store.release(board, id, second, '', 'BLOCKED');
  assert.match(store.getItem(board, id).item_hold_reason, /Released twice/, 'two on the strong route hold');
});

test('lib.hold.a-strong-item-still-takes-the-released: clause 2: a strong item still takes the Released-twice hold and shout [C7]', t => {
  const { board, first, second, id, claim } = routeBoard(t, 'strong', 'pullboard-release-route-strong-');
  claim(first); store.release(board, id, first, '', 'INELIGIBLE');
  claim(second); store.release(board, id, second, '', 'BLOCKED');
  const held = store.getItem(board, id);
  assert.equal(held.item_route, 'strong');
  assert.equal(held.item_hold_reason, `Released twice: ${first}: INELIGIBLE; ${second}: BLOCKED`);
  assert.equal(store.recentShouts(board).filter(row => row.shout_text.includes(`#${id} held after two releases`)).length, 1);
});

test('lib.hold.before-the-route-engine-a-mid-item: clause 3: before the route engine a mid item is still held [C7]', t => {
  const { board, first, second, id, claim } = routeBoard(t, 'mid', 'pullboard-release-route-old-', 'strong');
  board.executionEngineVersion = RELEASE_TWICE_ROUTE_ENGINE - 1;
  claim(first); store.release(board, id, first, '', 'INELIGIBLE');
  claim(second); store.release(board, id, second, '', 'BLOCKED');
  assert.match(store.getItem(board, id).item_hold_reason, /Released twice/);
  assert.equal(store.getItem(board, id).item_route, 'mid');
});
