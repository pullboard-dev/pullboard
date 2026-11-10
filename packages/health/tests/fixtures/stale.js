/** Actual captured hold expiry participates in the unchanged full reader oracle [B4,H16,A2]. */
import assert from 'node:assert/strict';
import { staleStateSnapshot } from '../../index.js';

/** Create a genuinely expired private hold using the fixture clock, then apply the native coordinator move. */
export async function seedStaleState({ board, box, store, exercise }) {
  const clock = board.clock;
  const now = clock.now();
  const item = store.addItem(board, { by: 'coordinator', lane: box.lane, title: 'Expired private parity hold' });
  try {
    board.clock = { now: () => new Date(now.getTime() - 86_400_000) };
    store.holdItem(board, item, { agentId: 'coordinator', reason: 'Private captured expiry for full reader parity' });
  } finally { board.clock = clock; }
  const snapshot = staleStateSnapshot(board, {}, { now });
  const result = await exercise('maintainStaleState', () => store.maintainStaleState(board, {
    agentId: 'coordinator', snapshot, health: {},
  }));
  assert.deepEqual(result?.holds, [item], 'the new operation really expires its captured hold');
  assert.equal(store.itemHold(board, item), null);
}
