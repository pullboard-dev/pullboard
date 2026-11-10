/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js src/person-signing.js apps/relay/src/io/passkeys.js */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import {
  assert,
  fixtureBoard,
  randomUUID,
  store,
  test,
} from '../../../tests/fixtures/scenarios/team.js';

test('a landing lease renewal or waiter poll writes no board event [Q1,Q2,Q3]', t => {
  const directory = '/fixture/lease-events';
  let milliseconds = Date.parse('2026-01-01T00:00:00Z');
  const board = fixtureBoard(t, { clock: { now: () => new Date(milliseconds) } });
  store.register(board, { lane: 'coordinator', path: directory });
  const owner = { agentId: 'coordinator', token: randomUUID(), branch: 'refs/heads/main', pid: process.pid };
  const waiter = { ...owner, token: randomUUID() };
  const granted = store.landingLeaseMove(board, { ...owner, action: 'request' });
  assert.equal(granted.acquired, true);
  assert.equal(store.landingLeaseMove(board, { ...waiter, action: 'request' }).position, 1);
  for (let second = 1; second <= 35 * 60; second += 1) {
    milliseconds += 1000;
    if (second % 5 === 0) {
      const renewed = store.landingLeaseMove(board, { ...owner, action: 'renew', generation: granted.generation });
      assert.equal(renewed.acquired, true, 'the same generation remains held throughout the simulation');
    }
    const queued = store.landingLeaseMove(board, { ...waiter, action: 'request' });
    assert.equal(queued.acquired, false, 'polling never steals a live holder');
  }
  store.landingLeaseMove(board, { ...owner, action: 'release', generation: granted.generation });
  const events = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='landing_lease' ORDER BY event_id").all();
  assert.equal(events.length, 3, 'only grant, initial queue and release are board events across 35 minutes');
  const state = store.landingLeaseState(board);
  assert.equal(state.holder, null);
  assert.equal(state.line.length, 1, 'suppressing polling events does not discard the waiting command');
});
