/** Reopened work follows its native builder and family activity, with ordinary fallback [H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { fixtureBoard } from './board-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { applyEngineMove } from '../src/engine.js';
import { prepareEngineMove } from '../src/engine.js';
import { defaults } from '../src/config.js';
import { reworkFamilyRoute } from '../src/rework-family-routing.js';
import { reworkRoutingWindows } from '../src/rework-family-routing.js';
import { sealReworkRoutingPolicy } from '../src/rework-family-routing.js';
import { canTake } from '../src/route-escalation.js';
import { routeOf } from '../src/seats.js';

const COMMIT = 'a'.repeat(40);

/** Build a clock-controlled private SQLite board for native rework-routing cases. */
function fixture(t, { enabled = true } = {}) {
  let at = Date.parse('2026-01-01T00:00:00.000Z');
  const board = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const builder = store.register(board, { lane: 'core', path: '/builder', route: 'mid', family: 'OpenAI' });
  const peer = store.register(board, { lane: 'core', path: '/peer', route: 'mid', family: 'OpenAI' });
  const other = store.register(board, { lane: 'core', path: '/other', route: 'mid', family: 'Claude' });
  if (enabled) store.setLineSetting(board, { agentId: 'coordinator', key: 'reworkSameFamily', value: true,
    reason: 'Exercise the frozen rework family policy.', window: { fixture: 1 } });
  store.setLineSetting(board, { agentId: 'coordinator', key: 'takeoverMinutes', value: 15,
    reason: 'Exercise the configured native seat takeover window.', window: { fixture: 1 } });
  const advance = milliseconds => { at += milliseconds; };
  return { board, builder, peer, other, advance, windows: reworkRoutingWindows(board, defaults()) };
}

/** Record a real native claim, optionally carrying the captured family-routing policy. */
function claim(board, id, agentId, reworkRoutingPolicy = undefined) {
  return store.claim(board, id, { agentId, lane: 'core', leaseMs: 60 * 60_000,
    ...(reworkRoutingPolicy ? { reworkRoutingPolicy } : {}),
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'fixture-bar' }) });
}

/** Build a submitted and rejected item using the repository's native board operations. */
function returned(f) {
  const id = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'returned work', criterion: 'prove it',
    specIds: ['B13'], route: 'mid', check: 'true', brief: 'Files: src/rework.js\nTest: returns to a live family seat' });
  claim(f.board, id, f.builder);
  submitFixture(f.board, id, { agentId: f.builder, commit: COMMIT, tree: COMMIT });
  store.verify(f.board, id, { agentId: f.other, decision: 'REJECT', reason: 'OTHER', note: 'needs one fix',
    clause: 'prove it', head: COMMIT, digest: 'fixture-bar', policy: 'any' });
  return id;
}

/** Resolve one builder's route through the production native-seat classifier. */
function route(board, id, agentId, policy) {
  return reworkFamilyRoute(board, store.getItem(board, id), { listAgents: store.listAgents,
    routeOf, canTake, policy, now: board.clock.now().getTime() });
}

test('[H16] returned work waits for its builder until gone, then prefers live same-family work and records portable fallback', t => {
  const f = fixture(t);
  const id = returned(f);
  assert.deepEqual(route(f.board, id, f.peer, f.windows).allowed, [f.builder], 'the recent builder event keeps first refusal');

  f.advance(f.windows.takeoverMs + 1);
  assert.deepEqual(route(f.board, id, f.peer, f.windows).allowed, [f.builder], 'an idle builder is retained until the shared gone grace expires');

  // A separate native claim makes the peer positively live; registration alone is not live activity.
  const unrelated = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'peer activity', criterion: 'prove it',
    route: 'mid', check: 'true', brief: 'Files: src/peer.js\nTest: records activity' });
  claim(f.board, unrelated, f.peer);
  f.advance(f.windows.graceMs);
  claim(f.board, unrelated, f.peer);
  const liveFamily = route(f.board, id, f.peer, f.windows);
  assert.equal(liveFamily.mode, 'family');
  assert.deepEqual(liveFamily.allowed, [f.peer]);

  store.release(f.board, unrelated, f.peer, 'finish the presence fixture');
  f.advance(f.windows.graceMs);
  const fallback = route(f.board, id, f.other, f.windows);
  assert.equal(fallback.mode, 'fallback', 'no same-family work event is still live');
  const routingPolicy = sealReworkRoutingPolicy(f.windows);
  const move = prepareEngineMove(f.board, 'claim', [id, { agentId: f.other, lane: 'core', leaseMs: 60 * 60_000,
    reworkRoutingPolicy: routingPolicy,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'fixture-bar' }) }]);
  assert.equal(move.args[1].reworkSameFamily, true, 'the native engine marks only the captured new policy');
  assert.equal(applyEngineMove(f.board, move, { sequence: 1, at: f.board.clock.now().toISOString() }).error, undefined);
  const fact = store.itemThread(f.board, id).find(row => row.type === 'fact' && row.id === routingPolicy.factId);
  assert.ok(fact, 'the sealed fact identity is used for fallback');
  assert.match(fact.text, /checked families: Claude, OpenAI/u);
});

test('[H16] enabling family routing does not change an already sealed legacy claim', t => {
  const f = fixture(t, { enabled: false });
  const id = returned(f);
  f.advance(2 * 60 * 60_000);
  const oldMove = prepareEngineMove(f.board, 'claim', [id, { agentId: f.peer, lane: 'core', leaseMs: 60 * 60_000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'fixture-bar' }) }]);
  assert.equal(oldMove.args[1].reworkSameFamily, undefined);
  store.setLineSetting(f.board, { agentId: 'coordinator', key: 'reworkSameFamily', value: true,
    reason: 'Enable the new routing for future moves only.', window: { fixture: 1 } });
  const outcome = applyEngineMove(f.board, oldMove, { sequence: 1, at: '2026-01-01T00:00:00.000Z' });
  assert.equal(outcome.error, undefined);
  assert.equal(store.getItem(f.board, id).item_owner, f.peer);
});
