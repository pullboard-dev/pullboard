/** Merge readers use explicit canonical native operations without changing history [V1,V4,H16,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { mergeOnlyBasis } from '../../../../merge/index.js';
import { mergeOnlyProblem } from '../../../../merge/index.js';
import { mergeOnlySourceValid } from '../../../../merge/index.js';
import { mergeOnlyLandingProblem } from '../../../../merge/index.js';
import { prepareMergeOnlySubmit } from '../../../../merge/index.js';
import { mainMovedWarnings } from '../../../../merge/index.js';

/** Populate an actual native item without inventing an acceptance or source receipt. */
function fixture(t) {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/fixture/coordinator' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Native merge reads' });
  return { board, id, item: store.getItem(board, id) };
}

test('store.io-board-light.merge-acceptance-ports-preserve-native-no: merge acceptance ports preserve native no-acceptance and immutable refusal semantics [V1,V4,H16]', (t) => {
  const { board, id, item } = fixture(t);
  const before = store.events(board);
  let reads = 0;
  const ports = {
    getItem: store.getItem,
    /** Observe the actual native projection while preserving its receiver and arguments. */
    acceptedVerdict(current, entry) {
      reads += 1;
      assert.equal(current, board);
      assert.equal(entry.item_id, id);
      return store.acceptedVerdict(current, entry);
    },
  };
  assert.equal(store.acceptedVerdict(board, item), undefined);
  assert.equal(mergeOnlyBasis(board, item, {}, ports), null);
  assert.equal(mergeOnlySourceValid('/unused-without-carry', board, item, {}, ports), true);
  assert.equal(mergeOnlyLandingProblem('/unused-without-carry', board, item, ports), null);
  assert.equal(reads, 2, 'both source and landing paths consult the supplied canonical reader');
  assert.equal(mergeOnlyProblem(board, item, null, {}, ports).code, 'MERGE_ONLY_PROOF');
  assert.equal(prepareMergeOnlySubmit(board, id, { gateGreen: true }, ports), null);
  assert.deepEqual(store.events(board), before, 'read-side provenance never records native moves');
});

test('store.io-board-light.missing-merge-ports-and-reader-failures: missing merge ports and reader failures remain explicit rather than granting carry [V1,V4,H16,C7]', (t) => {
  const { board, id, item } = fixture(t);
  assert.throws(() => mergeOnlyBasis(board, item), /explicit acceptedVerdict read port/u);
  assert.throws(() => mergeOnlySourceValid('/unused', board, item), /explicit acceptedVerdict read port/u);
  assert.throws(() => prepareMergeOnlySubmit(board, id, {}), /explicit getItem and acceptedVerdict read ports/u);
  assert.throws(() => mainMovedWarnings({ root: '/unused', board, trunk: 'unused' }), /explicit listAgents and listItems read ports/u);
  const failure = new Error('native acceptance reader unavailable');
  const ports = {
    /** A private caller boundary failure must propagate, never become an accepted carry. */
    acceptedVerdict() { throw failure; },
  };
  assert.throws(() => mergeOnlySourceValid('/unused', board, item, {}, ports), error => error === failure);
  assert.throws(() => mergeOnlyLandingProblem('/unused', board, item, ports), error => error === failure);
});
