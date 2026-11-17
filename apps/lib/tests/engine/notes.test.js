/** Typed notes preserve authority and historical replay on independent in-memory SQLite replicas [B29,B30,B31,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { appliedSequence } from '../../../../packages/state/index.js';
import { applyRelayMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { ITEM_NOTES_ENGINE } from '../../../../packages/state/light.js';
import { minimumMoveEngine } from '../../../../packages/moves/index.js';
import { fixtureBoard } from '../../../cli/tests/fixtures/board.js';

/** Seed identical private replicas without a background writer or already-active future receipt. */
function replicas(t) {
  const primary = fixtureBoard(t);
  const peer = fixtureBoard(t);
  store.register(primary, { lane: 'coordinator', path: '/fixture' });
  store.register(primary, { lane: 'web', path: '/fixture/web' });
  const id = store.addItem(primary, { by: 'coordinator', lane: 'web', title: 'Versioned conversation' });
  importBoard(peer, exportBoard(primary));
  return { boards: [primary, peer], id };
}

/** Deliver the exact move identity and ordered timestamp through the public authenticated replay entry. */
function deliver(board, move) {
  return applyRelayMove(board, move, { sequence: appliedSequence(board) + 1,
    at: '2026-10-25T00:00:00Z', kind: 'move', sender: { kind: 'agent', agent: 'web-1', userId: 'fixture' } });
}

test('lib.engine-notes.typed-conversation-notes-keep-exact-replica: typed conversation notes keep exact replica identity and an explicit historical engine floor [B29,B31,H16]', t => {
  const { boards, id } = replicas(t);
  const [primary, peer] = boards;
  const legacy = { ...prepareEngineMove(primary, 'appendFact', [id,
    { agentId: 'web-1', kind: 'note', text: 'An ordinary historical observation' }], { id: 'legacy-note' }), engine: ITEM_NOTES_ENGINE - 1 };
  const original = boards.map(board => deliver(board, legacy));
  assert.deepEqual(original[0], original[1]);
  assert.equal(original[0].error, undefined);
  const first = prepareEngineMove(primary, 'appendFact', [id,
    { agentId: 'web-1', kind: 'question', text: 'What stays byte-for-byte?\n<exact content>' }], { id: 'typed-question' });
  assert.equal(minimumMoveEngine('appendFact', first.args), ITEM_NOTES_ENGINE);
  const before = boards.map(board => store.itemThread(board, id));
  for (const board of boards) assert.throws(() => deliver(board, { ...first, engine: ITEM_NOTES_ENGINE - 1 }),
    /RELAY_MOVE.*introduced in engine/u);
  assert.deepEqual(boards.map(board => store.itemThread(board, id)), before, 'refusal leaves both threads unchanged');
  for (const kind of ['question', 'answer', 'plan', 'risk']) {
    const move = kind === 'question' ? first : prepareEngineMove(primary, 'appendFact', [id,
      { agentId: 'web-1', kind, text: `Exact ${kind} observation` }], { id: `typed-${kind}` });
    const outcomes = boards.map(board => deliver(board, move));
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.equal(outcomes[0].error, undefined);
  }
  assert.deepEqual(store.itemThread(primary, id), store.itemThread(peer, id));
  assert.deepEqual(store.allShouts(primary), []);
  assert.deepEqual(store.allShouts(peer), []);
  for (const [index, board] of boards.entries()) assert.deepEqual(applyRelayMove(board, legacy,
    { sequence: 1, at: '2026-10-25T00:00:00Z', kind: 'move', sender: { kind: 'agent', agent: 'web-1', userId: 'fixture' } }), original[index],
  'an acknowledged historical note remains replayable after the new floor');
});

test('lib.engine-notes.conversation-answers-do-not-acquire-judgment: conversation answers do not acquire judgment or person authority [B29,B30,H16]', t => {
  const { boards, id } = replicas(t);
  const board = boards[0];
  const old = board.executionEngineVersion;
  try {
    board.executionEngineVersion = ITEM_NOTES_ENGINE - 1;
    assert.throws(() => store.appendFact(board, id, { agentId: 'web-1', kind: 'answer', text: 'New label under old writer' }),
      { code: 'BAD_FACT_KIND' });
  } finally { board.executionEngineVersion = old; }
  const before = store.itemThread(board, id);
  assert.throws(() => store.appendFact(board, id, { agentId: 'web-1', kind: 'decision', text: 'A nonholder cannot decide' }),
    { code: 'FACT_JUDGEMENT' });
  assert.throws(() => store.appendFact(board, id, { agentId: 'web-1', kind: 'answer', text: 'I am not the person', asPerson: true }),
    { code: 'RIGOR_PERSON_ONLY' });
  assert.deepEqual(store.itemThread(board, id), before, 'authority refusals cannot append a partial note');
  const beforeItem = store.getItem(board, id);
  const answer = store.appendFact(board, id, { agentId: 'web-1', kind: 'answer', text: 'An attributed observation' });
  assert.equal(answer.by, 'web-1');
  const afterItem = store.getItem(board, id);
  for (const field of ['item_status', 'item_owner', 'item_lease_until', 'item_frozen_digest']) {
    assert.deepEqual(afterItem[field], beforeItem[field], `a conversation answer preserves ${field}`);
  }
  assert.deepEqual(store.openDecisions(board), []);
});
