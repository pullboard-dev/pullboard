/** A caller that asks for a coordinator seat adds one beside the main checkout; without it the coordinator stays one [C7,#10571]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentById } from '../../../index.js';
import { agentAt } from '../../../index.js';
import { closeBoard } from '../../../index.js';
import { register } from '../../../index.js';
import { ADVISOR_ROLE_ENGINE } from '../../../../state/light.js';
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
