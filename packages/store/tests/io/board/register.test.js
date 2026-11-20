/** A caller that asks for a coordinator seat adds one beside the main checkout; without it the coordinator stays one [C7,#10571]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem } from '../../../index.js';
import { agentById } from '../../../index.js';
import { agentAt } from '../../../index.js';
import { closeBoard } from '../../../index.js';
import { register } from '../../../index.js';
import { ADVISOR_ROLE_ENGINE } from '../../../../state/light.js';
import { NEEDS_ENGINE } from '../../../../state/light.js';
import { agentAbilities } from '../../../src/io/needs.js';
import { openKitBoard } from '../../fixtures/cell.js';

const MAIN = '/fixture/project';
const SEAT = '/fixture/project-coordinator-seat';

/** A board whose main checkout already joined as the coordinator. */
function boardWithCoordinator(t) {
  const board = openKitBoard(':memory:');
  t.after(() => closeBoard(board));
  assert.equal(register(board, { lane: 'coordinator', path: MAIN }), 'coordinator');
  return board;
}

test('store.io-board-register.a-coordinator-seat-joins-beside-main: clause 1: given coordinatorSeat, another worktree joins the coordinator lane as coordinator-<n> and the main checkout stays coordinator [C7]', t => {
  const board = boardWithCoordinator(t);
  const id = register(board, { lane: 'coordinator', path: SEAT, coordinatorSeat: true });
  assert.match(id, /^coordinator-[1-9][0-9]*$/u, 'the new seat is numbered in the coordinator lane');
  assert.equal(agentAt(board, SEAT).agent_lane, 'coordinator', 'the seat is in the coordinator lane');
  assert.equal(agentById(board, 'coordinator').agent_path, MAIN, 'the main checkout keeps the coordinator');
  assert.equal(register(board, { lane: 'coordinator', path: SEAT, coordinatorSeat: true }), id, 'registering again keeps the seat id');
});

test('store.io-board-register.without-the-ask-one-coordinator: clause 2: without coordinatorSeat, a second coordinator-lane worktree still refuses ONE_COORDINATOR [C7]', t => {
  const board = boardWithCoordinator(t);
  assert.throws(() => register(board, { lane: 'coordinator', path: SEAT }), { code: 'ONE_COORDINATOR' });
  assert.equal(agentAt(board, SEAT), undefined, 'no seat is registered');
});

test('store.io-board-register.clause-1-a-role-is-recorded: clause 1: register with role advisor records it so agentAt and agentById return agent_role advisor, and no role returns null [C7]', t => {
  const board = openKitBoard(':memory:');
  t.after(() => closeBoard(board));
  const id = register(board, { lane: 'core', path: '/fixture/advisor', role: 'advisor' });
  assert.equal(agentAt(board, '/fixture/advisor').agent_role, 'advisor');
  assert.equal(agentById(board, id).agent_role, 'advisor');
  const plain = register(board, { lane: 'core', path: '/fixture/plain' });
  assert.equal(agentAt(board, '/fixture/plain').agent_role, null);
  assert.equal(agentById(board, plain).agent_role, null);
});

test('store.io-board-register.clause-2-a-bad-role-is-refused: clause 2: a role other than advisor is refused BAD_ROLE, and a role below ADVISOR_ROLE_ENGINE is refused ENGINE_VERSION naming the upgrade [C7]', t => {
  const board = openKitBoard(':memory:');
  t.after(() => closeBoard(board));
  assert.throws(() => register(board, { lane: 'core', path: '/fixture/bad', role: 'boss' }), { code: 'BAD_ROLE' });
  assert.equal(agentAt(board, '/fixture/bad'), undefined, 'no seat is registered');
  board.executionEngineVersion = ADVISOR_ROLE_ENGINE - 1;
  assert.throws(() => register(board, { lane: 'core', path: '/fixture/old', role: 'advisor' }), error => error.code === 'ENGINE_VERSION' && /upgrade/u.test(error.message));
  assert.equal(agentAt(board, '/fixture/old'), undefined, 'no seat is registered');
});

/** A seat in the web lane with one item placed in the given state, the way the stage tests place items: the fixture records where it stands. */
function seatHolding(t, fields) {
  const board = openKitBoard(':memory:');
  t.after(() => closeBoard(board));
  const id = register(board, { lane: 'web', path: '/fixture/mover' });
  const item = addItem(board, { by: 'coordinator', lane: 'web', title: 'held item', brief: 'Files:\n- src/held.js' });
  board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
  try { board.db.prepare(`UPDATE item SET ${Object.keys(fields).map(key => `${key}=?`).join(', ')} WHERE item_id=?`).run(...Object.values(fields).map(value => (value === '$seat' ? id : value)), item); }
  finally { board.db.exec('DELETE FROM temp.moving'); }
  return { board, id, item };
}

test('store.io-board-register.explicit-move-when-free: clause 1: register with moveLane moves a seat holding no claimed, submitted, gate or review item to the named lane and logs a join event with from and to [C7]', t => {
  const board = openKitBoard(':memory:');
  t.after(() => closeBoard(board));
  const id = register(board, { lane: 'web', path: '/fixture/mover' });
  assert.equal(register(board, { lane: 'core', path: '/fixture/mover', moveLane: true }), id, 'the seat keeps its id');
  assert.equal(agentAt(board, '/fixture/mover').agent_lane, 'core', 'the seat is in the named lane');
  const join = board.db.prepare("SELECT event_detail AS detail FROM event WHERE event_by = ? AND event_kind = 'join' ORDER BY event_id DESC").get(id);
  assert.deepEqual({ from: JSON.parse(join.detail).from, to: JSON.parse(join.detail).lane }, { from: 'web', to: 'core' }, 'the join event names from and to');
});

test('store.io-board-register.move-refused-while-held: clause 2: the same call for a seat holding an item in any of those states throws LANE_HELD naming the item ids, with a next: line that names release and join [C7]', t => {
  for (const fields of [{ item_status: 'claimed', item_owner: '$seat', item_lease_until: '2999-01-01T00:00:00.000Z', item_frozen_digest: 'd'.repeat(64) },
    { item_status: 'submitted', item_owner: '$seat', item_built_by: '$seat', item_commit: 'a'.repeat(40), item_frozen_digest: 'd'.repeat(64) }]) {
    const { board, id, item } = seatHolding(t, fields);
    assert.throws(() => register(board, { lane: 'core', path: '/fixture/mover', moveLane: true }), error => error.code === 'LANE_HELD'
      && error.message.includes(`#${item}`) && /release/u.test(error.next) && /join core/u.test(error.next), `${fields.item_status} blocks the move`);
    assert.equal(agentAt(board, '/fixture/mover').agent_lane, 'web', 'the seat stays in its lane');
    assert.equal(agentById(board, id).agent_lane, 'web');
  }
  const { board, item } = seatHolding(t, { item_status: 'submitted', item_built_by: 'someone-else', item_commit: 'a'.repeat(40), item_frozen_digest: 'd'.repeat(64), item_review_by: '$seat', item_review_until: '2999-01-01T00:00:00.000Z' });
  assert.throws(() => register(board, { lane: 'core', path: '/fixture/mover', moveLane: true }), error => error.code === 'LANE_HELD' && error.message.includes(`#${item}`), 'a review reservation blocks the move');
});

test('store.io-board-register.abilities-real-path: register stores who.abilities for a fresh join and for a rejoin of the same seat, leaves them when none are given, and refuses ENGINE_VERSION below NEEDS_ENGINE [C7,U136]', t => {
  const board = openKitBoard(':memory:');
  t.after(() => closeBoard(board));
  const id = register(board, { lane: 'core', path: '/fixture/abilities', abilities: ['browser'] });
  assert.deepEqual(agentAbilities(board, id), ['browser'], 'a fresh join stores the declaration');
  assert.equal(register(board, { lane: 'core', path: '/fixture/abilities' }), id);
  assert.deepEqual(agentAbilities(board, id), ['browser'], 'a rejoin that names none leaves it');
  assert.equal(register(board, { lane: 'core', path: '/fixture/abilities', abilities: ['browser', 'gui'] }), id);
  assert.deepEqual(agentAbilities(board, id), ['browser', 'gui'], 'a rejoin of the same seat stores the new declaration');
  const plain = register(board, { lane: 'core', path: '/fixture/plain' });
  assert.deepEqual(agentAbilities(board, plain), [], 'a seat that declared none reads []');
  assert.throws(() => register(board, { lane: 'core', path: '/fixture/bad', abilities: ['gpu'] }), { code: 'USAGE' });
  assert.equal(agentAt(board, '/fixture/bad'), undefined, 'a refused declaration registers no seat');
  const current = board.executionEngineVersion;
  try {
    board.executionEngineVersion = NEEDS_ENGINE - 1;
    assert.throws(() => register(board, { lane: 'core', path: '/fixture/old', abilities: ['browser'] }), { code: 'ENGINE_VERSION' });
  } finally { board.executionEngineVersion = current; }
});
