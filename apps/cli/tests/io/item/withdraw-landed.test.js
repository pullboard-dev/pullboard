/** withdraw.refuseLanded: withdraw refuses an item whose commit is on main, and is off by default [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fixtureCommittedGraph } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { runFixtureChild } from '../../fixtures/child.js';
import * as roadmapView from '../../../../../packages/roadmap/index.js';
import { refuseLandedWithdraw } from '../../../src/io/item/withdraw-landed.js';

/** A real repo on main with one landed commit, and a side commit that never reached main. */
function repo(t) {
  const graph = fixtureCommittedGraph('withdraw-landed-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  const checkout = (...args) => assert.equal(runFixtureChild('git', ['checkout', '-q', ...args], { cwd: graph.root, encoding: 'utf8' }).status, 0);
  graph.put('base.txt', 'base');
  graph.commit();
  checkout('-b', 'side');
  graph.put('side.txt', 'side');
  const side = graph.commit();
  checkout('main');
  graph.put('landed.txt', 'landed');
  return { root: graph.root, landed: graph.commit(), side };
}
const ON = { withdraw: { refuseLanded: true } };

test('cli.io-item-withdraw-landed.with-withdraw-refuselanded-on-withdrawing-an-item: clause 1: with withdraw.refuseLanded on, withdrawing an item whose commit is on main is refused WITHDRAW_LANDED naming pullboard merged [C7]', t => {
  const { root, landed } = repo(t);
  assert.throws(() => refuseLandedWithdraw(ON, root, { item_id: 7, item_commit: landed, item_merged_commit: null }, roadmapView),
    error => error.code === 'WITHDRAW_LANDED' && /pullboard merged 7/u.test(`${error.message} ${error.next ?? ''}`));
  assert.throws(() => refuseLandedWithdraw(ON, root, { item_id: 8, item_commit: null, item_merged_commit: landed }, roadmapView), { code: 'WITHDRAW_LANDED' });
});

test('cli.io-item-withdraw-landed.with-withdraw-refuselanded-on-an-item-whose: clause 2: with withdraw.refuseLanded on, an item whose commit is not on main still withdraws [C7]', t => {
  const { root, side } = repo(t);
  assert.doesNotThrow(() => refuseLandedWithdraw(ON, root, { item_id: 9, item_commit: side, item_merged_commit: null }, roadmapView));
  assert.doesNotThrow(() => refuseLandedWithdraw(ON, root, { item_id: 10, item_commit: null, item_merged_commit: null }, roadmapView));
});

test('cli.io-item-withdraw-landed.with-withdraw-refuselanded-off-the-default-withdraw: clause 3: with withdraw.refuseLanded off, the default, withdraw of a landed item behaves as before [C7]', t => {
  const { root, landed } = repo(t);
  assert.doesNotThrow(() => refuseLandedWithdraw({}, root, { item_id: 11, item_commit: landed, item_merged_commit: null }));
  assert.doesNotThrow(() => refuseLandedWithdraw({ withdraw: { review: true } }, root, { item_id: 11, item_commit: landed, item_merged_commit: null }));
});
