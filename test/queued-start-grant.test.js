/** A queued gate whose claim lapsed while it waited still starts for the seat that queued it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem } from '../packages/store/index.js';
import { claim } from '../packages/store/index.js';
import { closeBoard } from '../packages/store/index.js';
import { register } from '../packages/store/index.js';
import { requireAgentGrant } from '../packages/state/index.js';
import { ENGINE_VERSION } from '../packages/state/index.js';
import { QUEUED_START_GRANT_ENGINE } from '../src/queued-start-grant-engine.js';
import { boardFixture } from './next-order-fixture.js';
import { FREEZE } from './next-order-fixture.js';

const MINUTE = 60_000;

/** One item claimed for a minute by the builder, with its gate queued under that claim; the caller closes the board. */
function queuedFixture(t, { rivalFirst = false } = {}) {
  const { board, builder } = boardFixture();
  t.after(() => closeBoard(board));
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Queued gate fixture', route: 'strong' });
  claim(board, id, { agentId: builder, lane: 'core', leaseMs: MINUTE, freeze: FREEZE });
  if (rivalFirst) {
    // The builder's lease lapsed, and another seat took the item before the builder's gate record was read.
    board.db.prepare('UPDATE item SET item_lease_until=? WHERE item_id=?').run(new Date(Date.now() - MINUTE).toISOString(), id);
    claim(board, id, { agentId: register(board, { lane: 'core', path: '/rival', route: 'strong' }), lane: 'core', leaseMs: 60 * MINUTE, freeze: FREEZE });
  }
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)')
    .run(`submit_handoff:${id}`, JSON.stringify({ id: 'job-1', agentId: builder, state: 'queued' }));
  const later = new Date(Date.now() + 2 * 60 * MINUTE);
  const start = (agentId, engine = ENGINE_VERSION) => ({ version: 1, engine, id: `start-${agentId}-${engine}`, operation: 'startSubmitHandoff',
    args: [id, { agentId, job: 'job-1' }], actor: agentId });
  return { board, builder, id, later, start };
}

test('clause 1: startSubmitHandoff for the job the same seat queued is admitted after its claim lease lapses [C7]', t => {
  const { board, builder, later, start } = queuedFixture(t);
  assert.doesNotThrow(() => requireAgentGrant(board, start(builder), later));
  assert.throws(() => requireAgentGrant(board, start(builder, QUEUED_START_GRANT_ENGINE - 1), later), { code: 'AGENT_GRANT_EXPIRED' },
    'a move recorded before this engine replays with its original refusal');
  const other = { ...start(builder), args: [start(builder).args[0], { agentId: builder, job: 'job-other' }] };
  assert.throws(() => requireAgentGrant(board, other, later), { code: 'AGENT_GRANT_EXPIRED' }, 'only the queued job itself starts');
});

test('clause 2: startSubmitHandoff stays refused once another seat has claimed the item [C7]', t => {
  const { board, builder, later, start } = queuedFixture(t, { rivalFirst: true });
  assert.throws(() => requireAgentGrant(board, start(builder), later), { code: /^AGENT_GRANT_/u });
});
