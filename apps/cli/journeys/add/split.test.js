/** pullboard split files one child per numbered clause of a parent, each carrying its clause and check, each after the one before [C7,#8916]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const CHECK = 'node --test web/handler.test.js';
const CRITERION = '1. the handler returns the canonical result [test]. 2. the handler refuses an empty body [test].';

/** File a two-clause parent in a scratch project, split it, and read back the parent and its children from the board. */
async function splitParent(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Handler', '--criterion', CRITERION, '--check', CHECK, '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const parent = JSON.parse(added.out).item.item_id;
  const split = await box.runLocal(box.repo, 'split', String(parent), '--json');
  assert.equal(split.code, 0, split.out + split.err);
  const { children } = JSON.parse(split.out);
  const items = await onBoard(box, board => children.map(id => store.getItem(board, id)));
  return { parent, children, items };
}

test('cli.journeys-add-split.split-adds-one-child-item-per: clause 1: split adds one child item per numbered clause of the parent, each carrying its clause and check [C7,#8916]', async t => {
  const { parent, items } = await splitParent(t);
  assert.equal(items.length, 2);
  assert.match(items[0].item_criterion, /canonical result/u);
  assert.doesNotMatch(items[0].item_criterion, /empty body/u);
  assert.match(items[1].item_criterion, /empty body/u);
  for (const item of items) {
    assert.equal(item.item_check, CHECK);
    assert.equal(item.item_parent_id, parent);
    assert.equal(item.item_lane, 'web');
  }
});

test('cli.journeys-add-split.split-files-each-child-after-the: clause 2: split files each child after the previous one and the first after nothing [C7,#8916]', async t => {
  const { children, items } = await splitParent(t);
  assert.equal(items[0].item_after ?? '', '');
  assert.equal(String(items[1].item_after), String(children[0]));
});

test('cli.journeys-add-split.split-refuses-a-parent-with-fewer: clause 1: split refuses a parent with fewer than two numbered clauses and files nothing [C7,#8916]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Single', '--criterion', 'the handler returns the canonical result [test]', '--check', CHECK, '--json');
  const parent = JSON.parse(added.out).item.item_id;
  const split = await box.runLocal(box.repo, 'split', String(parent), '--json');
  assert.notEqual(split.code, 0);
  assert.equal(JSON.parse(split.out).error.code, 'SPLIT_ONE_CLAUSE');
});
