/** @pullboard-test-input source-cell store */
/** A rejected submission's old head stays unverified after a sibling resubmission, until the item is accepted [V17,V1]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { submitFixture } from '../../fixtures/submit.js';
import {
  cellBoard,
  cellItem,
  cellSeat,
} from '../../fixtures/cell.js';

const OLD = 'a'.repeat(40);
const SIBLING = 'b'.repeat(40);
const BAR = { text: 'Tracked work', digest: 'digest:tracked' };

/** Item A submitted at OLD, rejected, reclaimed and resubmitted at a sibling head. */
function resubmitted(t) {
  const board = cellBoard(t);
  const builder = cellSeat(board, { lane: 'web', path: '/builder' }).id;
  const id = cellItem(board, { lane: 'web', title: 'Old head', criterion: 'Tracked work', specIds: ['G1'] }).item_id;
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze: () => BAR });
  submitFixture(board, id, { agentId: builder, commit: OLD, tree: OLD });
  store.verify(board, id, { agentId: 'coordinator', decision: 'REJECT', reason: 'OTHER', note: 'revise', clause: 'Tracked work', head: OLD, digest: BAR.digest, policy: 'any' });
  store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze: () => BAR });
  submitFixture(board, id, { agentId: builder, commit: SIBLING, tree: SIBLING });
  return { board, id };
}

test('clause 1: after a sibling resubmission both the old and the latest head are listed as unverified for the item [V17,V1]', (t) => {
  const { board, id } = resubmitted(t);
  const heads = store.unverifiedSubmissions(board).filter(s => s.item_id === id).map(s => s.item_commit).sort();
  assert.deepEqual(heads, [OLD, SIBLING]);
  assert.equal(store.getItem(board, id).item_commit, SIBLING);
});

test('clause 2: accepting the latest sibling head clears every historical head [V17,V1]', (t) => {
  const { board, id } = resubmitted(t);
  store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'latest head', head: SIBLING, digest: BAR.digest, policy: 'any' });
  assert.deepEqual(store.unverifiedSubmissions(board).filter(s => s.item_id === id), []);
});
