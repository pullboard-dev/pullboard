/** A quoted test path in an item's check infers its brief like a bare one, so fixture adds never refuse NO_BRIEF [B14,C7,#3120]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { fixtureBoard } from './board-fixture.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { fixtureAdd } from './testkit-fixture.js';

const helpers = createE2eHelpers();
test.after(helpers.cleanup);

for (const [label, check] of [
  ['single-quoted', "node bin/run-tests.js 'test/x.test.js'"],
  ['double-quoted', 'node bin/run-tests.js "test/x.test.js"'],
  ['bare', 'node bin/run-tests.js test/x.test.js'],
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
    check: "node bin/run-tests.js 'test/x.test.js\"" }), { code: 'NO_BRIEF' });
});

test("clause 1: pullboard add with --check \"node bin/run-tests.js 'test/x.test.js'\" and no brief succeeds with a brief naming the test [B14,C7,#3120]", () => {
  const box = helpers.project('true', helpers.sandbox());
  const added = fixtureAdd(box.run, box.repo, 'web', 'Quoted check', '--specs', 'G1', '--criterion', 'x passes [test]',
    '--check', "node bin/run-tests.js 'test/x.test.js'", '--json');
  assert.equal(added.code, 0, added.out + added.err);
  const { item } = JSON.parse(added.out);
  assert.match(item.item_brief, /^Test: test\/x\.test\.js$/mu, item.item_brief);
  assert.equal(item.item_route, 'mid', 'an undiagnosed default starts mid, never a light add that refuses');
});
