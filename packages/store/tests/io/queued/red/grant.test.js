/** A queued gate whose claim lapsed while it waited still starts for the seat that queued it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem } from '../../../../index.js';
import { claim } from '../../../../index.js';
import { register } from '../../../../index.js';
import { recordSubmitHandoff } from '../../../../../jobs/index.js';
import { requireAgentGrant } from '../../../../../state/index.js';
import { ENGINE_VERSION } from '../../../../../state/index.js';
import { QUEUED_START_GRANT_ENGINE } from '../../../../../state/light.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';

/** The minimal frozen bar a claim needs. */
const FREEZE = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

const MINUTE = 60_000;

/** One item claimed for a minute by the builder, with its gate queued under that claim; the board closes with the test. */
function queuedFixture(t, { rivalFirst = false } = {}) {
  const board = fixtureBoard(t);
  register(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = register(board, { lane: 'core', path: '/builder', route: 'strong' });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Queued gate fixture', route: 'strong' });
  claim(board, id, { agentId: builder, lane: 'core', leaseMs: MINUTE, freeze: FREEZE });
  if (rivalFirst) {
    // The builder's lease lapsed, and another seat took the item before the builder's gate record was read.
    board.db.prepare('UPDATE item SET item_lease_until=? WHERE item_id=?').run(new Date(Date.now() - MINUTE).toISOString(), id);
    claim(board, id, { agentId: register(board, { lane: 'core', path: '/rival', route: 'strong' }), lane: 'core', leaseMs: 60 * MINUTE, freeze: FREEZE });
  }
  recordSubmitHandoff(board.db, id, { version: 1, id: 'job-1', agentId: builder, commit: 'c'.repeat(40), state: 'queued' });
  const later = new Date(Date.now() + 2 * 60 * MINUTE);
  const start = (agentId, engine = ENGINE_VERSION) => ({ version: 1, engine, id: `start-${agentId}-${engine}`, operation: 'startSubmitHandoff',
    args: [id, { agentId, job: 'job-1' }], actor: agentId });
  return { board, builder, id, later, start };
}

test('store.io-queued-red-grant.startsubmithandoff-for-the-job-the-same: clause 1: startSubmitHandoff for the job the same seat queued is admitted after its claim lease lapses [C7]', t => {
  const { board, builder, later, start } = queuedFixture(t);
  assert.doesNotThrow(() => requireAgentGrant(board, start(builder), later));
  assert.throws(() => requireAgentGrant(board, start(builder, QUEUED_START_GRANT_ENGINE - 1), later), { code: 'AGENT_GRANT_EXPIRED' },
    'a move recorded before this engine replays with its original refusal');
  const other = { ...start(builder), args: [start(builder).args[0], { agentId: builder, job: 'job-other' }] };
  assert.throws(() => requireAgentGrant(board, other, later), { code: 'AGENT_GRANT_EXPIRED' }, 'only the queued job itself starts');
});

test('store.io-queued-red-grant.startsubmithandoff-stays-refused-once-another-seat: clause 2: startSubmitHandoff stays refused once another seat has claimed the item [C7]', t => {
  const { board, builder, later, start } = queuedFixture(t, { rivalFirst: true });
  assert.throws(() => requireAgentGrant(board, start(builder), later), { code: /^AGENT_GRANT_/u });
});

test('store.io-queued-red-grant.no-board-meta-hand-off-row: clause 2: no board_meta hand-off row exists and the queued start reads the gate job on the real grant path [C7]', t => {
  const { board, builder, id, later, start } = queuedFixture(t);
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key GLOB 'submit_handoff*'").get().n, 0);
  assert.equal(board.db.prepare("SELECT job_item FROM job WHERE job_id='job-1'").get().job_item, id);
  assert.doesNotThrow(() => requireAgentGrant(board, start(builder), later));
});
