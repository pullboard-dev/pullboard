/** A quoted test path in an item's check infers its brief like a bare one, so fixture adds never refuse NO_BRIEF [B14,C7,#3120]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../index.js';
import { fixtureBoard } from '../../../../../../../apps/cli/tests/fixtures/board.js';

for (const [label, check] of [
  ['single-quoted', "node apps/cli/src/io/run/tests.js 'test/x.test.js'"],
  ['double-quoted', 'node apps/cli/src/io/run/tests.js "test/x.test.js"'],
  ['bare', 'node apps/cli/src/io/run/tests.js test/x.test.js'],
]) {
  test(`add with a ${label} test path in --check and no brief infers a brief naming it [B14,C7,#3120]`, t => {
    const board = fixtureBoard(t);
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `${label} check`, route: 'mid', criterion: 'x passes', check });
    const { item_brief: brief } = store.getItem(board, id);
    assert.match(brief, /^Test: test\/x\.test\.js$/mu, brief);
    assert.match(brief, /^- test\/x\.test\.js$/mu, brief);
  });
}

test('a quote that does not close around the path infers nothing and still refuses NO_BRIEF [B14,C7,#3120]', t => {
  const board = fixtureBoard(t);
  assert.throws(() => store.addItem(board, { by: 'coordinator', lane: 'web', title: 'unbalanced', route: 'mid', criterion: 'x passes',
    check: "node apps/cli/src/io/run/tests.js 'test/x.test.js\"" }), { code: 'NO_BRIEF' });
});
