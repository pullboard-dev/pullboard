/** A refused flake ratchet ends the landing as a recorded block, so a restart never gates the batch again [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { prepareFlakeLanding } from '../../../src/io/step/publish.js';
import * as store from '../../../../store/index.js';
import { flakeRatchetBeforeGate } from '../../../src/io/step/trunk.js';
import { flakeRatchetOrBlock } from '../../../src/io/step/trunk.js';

/** A gating batch on a real board whose ratchet port answers as the test asks. */
function gating(t, ratchet) {
  const board = cellBoard(t, ':memory:');
  cellSeat(board, { lane: 'coordinator', path: '/coordinator' });
  const said = [];
  const state = { board, say: text => said.push(text), landingPorts: { landingFlakeRatchet: () => ratchet },
    write: async (operation, args) => store[operation](board, ...args), batch: null };
  state.batch = store.recordLandingBatch(board, { agentId: 'coordinator', revision: 0, batch: { version: 1, id: 'ratchet-block', state: 'gating',
    base: 'a'.repeat(40), tip: 'b'.repeat(40), root: '/fixture', branch: 'refs/heads/main', owner: 'coordinator', logPath: '/fixture/log', items: [], candidates: [], conflicts: [] } });
  return { state, said, latest: () => store.landingBatches(board).find(batch => batch.id === 'ratchet-block') };
}

test('landing.publish.a-refused-ratchet-records-the-batch: a refused ratchet records the batch blocked with FLAKE_RATCHET and stops the landing [C7]', async t => {
  const { state, said, latest } = gating(t, { allowed: false, unprotected: [{ file: 'test/flaky.test.js', name: 'case' }], malformed: [], unjustified: [] });
  assert.equal(await flakeRatchetOrBlock(state), false);
  assert.deepEqual([latest().state, latest().refusal?.code], ['blocked', 'FLAKE_RATCHET']);
  assert.match(said.join('\n'), /nothing landed: .*test\/flaky\.test\.js :: case/);
});

test('landing.publish.an-allowed-ratchet-binds-its-snapshot: an allowed ratchet binds its snapshot and lets the landing go on [C7]', async t => {
  const snapshot = { version: 1, eventId: 0, count: 0, quarantines: [] };
  const { state, latest } = gating(t, { allowed: true, unprotected: [], malformed: [], unjustified: [], snapshot });
  assert.equal(await flakeRatchetOrBlock(state), true);
  assert.equal(latest().state, 'gating');
});

test('landing.publish.before-its-gate-a-refused-ratchet: before its gate a refused ratchet blocks the batch FLAKE_RATCHET and starts no gate [C7]', async t => {
  const { state, said, latest } = gating(t, { allowed: false, unprotected: [{ file: 'test/flaky.test.js', name: 'case' }], malformed: [], unjustified: [] });
  await assert.rejects(() => flakeRatchetBeforeGate(state), { code: 'FLAKE_RATCHET', message: /test\/flaky\.test\.js :: case/ });
  assert.deepEqual([latest().state, latest().refusal?.code], ['blocked', 'FLAKE_RATCHET']);
  assert.deepEqual(said, []);
  assert.equal(state.gates, undefined, 'no gate state was created');
});

test('landing.publish.before-its-gate-an-allowed-ratchet: before its gate an allowed ratchet changes nothing and the publish step keeps its own check [C7]', async t => {
  const { state, latest } = gating(t, { allowed: true, unprotected: [], malformed: [], unjustified: [], snapshot: { version: 1, eventId: 0, count: 0, quarantines: [] } });
  await flakeRatchetBeforeGate(state);
  assert.equal(latest().state, 'gating');
  assert.equal(latest().flakeRatchet, undefined, 'the snapshot binds later, after the gate');
  await assert.rejects(() => prepareFlakeLanding({ ...state, landingPorts: { landingFlakeRatchet: () => ({ allowed: false, unprotected: [{ file: 'a.test.js', name: 'n' }], malformed: [], unjustified: [] }) } }), { code: 'FLAKE_RATCHET' });
});
