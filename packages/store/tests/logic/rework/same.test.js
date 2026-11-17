import { REJECT_OPEN_ENGINE } from '../../../../state/index.js';
/** Reopened work follows its native builder and family activity, with ordinary fallback [H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { submitFixture } from '../../fixtures/submit.js';
import { applyEngineMove } from '../../../../state/index.js';
import { prepareEngineMove } from '../../../../state/index.js';
import { defaults } from '../../../../config/index.js';
import { reworkFamilyRoute } from '../../../index.js';
import { sealReworkRoutingPolicy } from '../../../index.js';
import { canTake } from '../../../../seats/index.js';
import { routeOf } from '../../../../seats/index.js';
import { SEAT_LIVE_WINDOW_MS } from '../../../index.js';
import { maintenanceDurations } from '../../../../config/index.js';

const COMMIT = 'a'.repeat(40);

/** Build a clock-controlled private SQLite board for native rework-routing cases. */
function fixture(t, { enabled = true, builderFamily = 'OpenAI' } = {}) {
  let at = Date.parse('2026-01-01T00:00:00.000Z');
  const board = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  // These controls prove replay of the former first-refusal policy, not the current rejection rule.
  board.executionEngineVersion = REJECT_OPEN_ENGINE - 1;
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const builder = store.register(board, { lane: 'core', path: '/builder', route: 'mid', family: builderFamily });
  const peer = store.register(board, { lane: 'core', path: '/peer', route: 'mid', family: 'OpenAI' });
  const other = store.register(board, { lane: 'core', path: '/other', route: 'mid', family: 'Claude' });
  if (enabled) store.setLineSetting(board, { agentId: 'coordinator', key: 'reworkSameFamily', value: true,
    reason: 'Exercise the frozen rework family policy.', window: { fixture: 1 } });
  store.setLineSetting(board, { agentId: 'coordinator', key: 'takeoverMinutes', value: 15,
    reason: 'Exercise the configured native seat takeover window.', window: { fixture: 1 } });
  const advance = milliseconds => { at += milliseconds; };
  const takeoverMinutes = store.lineSettings(board).takeoverMinutes;
  const windows = { takeoverMs: typeof takeoverMinutes === 'number' ? takeoverMinutes * 60_000 : SEAT_LIVE_WINDOW_MS,
    graceMs: maintenanceDurations(defaults().worktreeMaintenance).graceMs };
  return { board, builder, peer, other, advance, windows };
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
    routeOf, canTake, seatFamily: board.nativePorts.seatFamily, canonicalFamily: board.nativePorts.canonicalFamily,
    policy, now: board.clock.now().getTime() });
}

test('store.logic-rework-same.h16-returned-work-waits-for-its: [H16] returned work waits for its builder until gone, then prefers live same-family work and records portable fallback', t => {
  const f = fixture(t);
  const id = returned(f);
  assert.deepEqual(route(f.board, id, f.peer, f.windows).allowed, [f.builder], 'the recent builder event keeps first refusal');
  const peerNext = store.nextFor(f.board, { agentId: f.peer, lane: 'core', reworkRoutingPolicy: f.windows });
  assert.equal(peerNext.item, null, 'next does not offer the returned item to a different family while its builder is live');
  assert.ok(peerNext.reasons.some(reason => reason.includes(`reserved for ${f.builder}`)));
  assert.throws(() => claim(f.board, id, f.peer, sealReworkRoutingPolicy(f.windows)), { code: 'REOPEN_HELD_FOR_BUILDER' },
    'the native writer rechecks the live builder instead of trusting next');

  f.advance(f.windows.takeoverMs + 1);
  assert.deepEqual(route(f.board, id, f.peer, f.windows).allowed, [f.builder], 'an idle builder is retained until the shared gone grace expires');

  // A separate native claim makes the peer positively live; registration alone is not live activity.
  const unrelated = store.addItem(f.board, { by: 'coordinator', lane: 'core', title: 'peer activity', criterion: 'prove it',
    route: 'mid', check: 'true', brief: 'Files: src/peer.js\nTest: records activity' });
  claim(f.board, unrelated, f.peer);
  f.advance(f.windows.graceMs);
  claim(f.board, unrelated, f.peer);
  store.release(f.board, unrelated, f.peer, 'finish the presence fixture', 'OTHER');
  store.holdItem(f.board, unrelated, { agentId: 'coordinator', reason: 'Keep the presence fixture out of ordinary next.' });
  const liveFamily = route(f.board, id, f.peer, f.windows);
  assert.equal(liveFamily.mode, 'family');
  assert.deepEqual(liveFamily.allowed, [f.peer]);
  assert.throws(() => claim(f.board, id, f.other, sealReworkRoutingPolicy(f.windows)), { code: 'REOPEN_HELD_FOR_BUILDER' },
    'the native writer refuses a different family while a same-family seat is live');
  assert.equal(store.nextFor(f.board, { agentId: f.peer, lane: 'core', reworkRoutingPolicy: f.windows }).item.item_id, id);
  assert.equal(store.nextFor(f.board, { agentId: f.other, lane: 'core', reworkRoutingPolicy: f.windows }).item, null,
    'a live same-family seat excludes other families from next');

  f.advance(f.windows.graceMs);
  const fallback = route(f.board, id, f.other, f.windows);
  assert.equal(fallback.mode, 'fallback', 'no same-family work event is still live');
  assert.equal(store.nextFor(f.board, { agentId: f.other, lane: 'core', reworkRoutingPolicy: f.windows }).item.item_id, id,
    'ordinary next offers the item after the family grace expires');
  const routingPolicy = sealReworkRoutingPolicy(f.windows);
  const move = prepareEngineMove(f.board, 'claim', [id, { agentId: f.other, lane: 'core', leaseMs: 60 * 60_000,
    reworkRoutingPolicy: routingPolicy,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'fixture-bar' }) }]);
  assert.equal(move.args[1].reworkSameFamily, true, 'the native engine marks only the captured new policy');
  assert.equal(applyEngineMove(f.board, { ...move, engine: REJECT_OPEN_ENGINE - 1 }, { sequence: 1, at: f.board.clock.now().toISOString() }).error, undefined);
  const fact = store.itemThread(f.board, id).find(row => row.type === 'fact' && row.id === routingPolicy.factId);
  assert.ok(fact, 'the sealed fact identity is used for fallback');
  assert.match(fact.text, /checked families: anthropic, openai/u);
});

test('store.logic-rework-same.h16-an-unknown-recorded-family-returns: [H16] an unknown recorded family returns to the ordinary queue without a family fact', t => {
  const f = fixture(t, { builderFamily: null });
  const id = returned(f);
  f.advance(f.windows.graceMs + 1);

  const ordinary = route(f.board, id, f.other, f.windows);
  assert.equal(ordinary.mode, 'ordinary');
  assert.equal(ordinary.builderFamily, null);
  assert.equal(store.nextFor(f.board, { agentId: f.other, lane: 'core', reworkRoutingPolicy: f.windows }).item.item_id, id);

  claim(f.board, id, f.other, sealReworkRoutingPolicy(f.windows));
  assert.equal(store.getItem(f.board, id).item_owner, f.other);
  assert.equal(store.itemThread(f.board, id).some(row => row.type === 'fact' && /checked families/u.test(row.text)), false,
    'unknown family uses ordinary routing and does not invent a family fallback fact');
});

test('store.logic-rework-same.h16-enabling-family-routing-does-not: [H16] enabling family routing does not change an already sealed legacy claim', t => {
  const f = fixture(t, { enabled: false });
  const id = returned(f);
  f.advance(2 * 60 * 60_000);
  const oldMove = prepareEngineMove(f.board, 'claim', [id, { agentId: f.peer, lane: 'core', leaseMs: 60 * 60_000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'fixture-bar' }) }]);
  assert.equal(oldMove.args[1].reworkSameFamily, undefined);
  store.setLineSetting(f.board, { agentId: 'coordinator', key: 'reworkSameFamily', value: true,
    reason: 'Enable the new routing for future moves only.', window: { fixture: 1 } });
  const outcome = applyEngineMove(f.board, oldMove, { sequence: 1, at: f.board.clock.now().toISOString() });
  assert.equal(outcome.error, undefined);
  assert.equal(store.getItem(f.board, id).item_owner, f.peer);
});
