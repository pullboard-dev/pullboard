/** add files an over-budget item as a parent with one cut child per clause, using the board's itemBuildBudgetMinutes [C7,#2539]. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const CRITERION = '1. the first clause holds [test] 2. the second clause holds [test] 3. the third clause holds [test]';
const CHECK = 'node --test web/handler.test.js';

/** Commit the board build budget to the fixture's pullboard.json, or leave the setting out when budget is null. */
function setBudget(box, budget) {
  if (budget === null) return;
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.itemBuildBudgetMinutes = budget;
  writeFileSync(file, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: set the item build budget [G1]');
}

/** Add a 3-clause checked item with the given estimate; return the parent and every item whose parent it is. */
async function addSized(t, budget, minutes) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  setBudget(box, budget);
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Sized item', '--criterion', CRITERION, '--check', CHECK, '--expected-minutes', String(minutes), '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  return onBoard(box, board => ({ parent: store.getItem(board, id), children: store.listItems(board, { all: true }).filter(item => item.item_parent_id === id) }));
}

test('cli.journeys-add-item-size.over-budget-add-files-cut-children: clause 1: with itemBuildBudgetMinutes set to 6, add of a 3-clause item at 18 minutes files a parent and three 6-minute children inheriting the check [C7,#2539]', async t => {
  const { parent, children } = await addSized(t, 6, 18);
  assert.equal(parent.item_expected_build_minutes, 18);
  assert.equal(children.length, 3);
  assert.deepEqual(children.map(child => child.item_expected_build_minutes), [6, 6, 6]);
  assert.deepEqual(children.map(child => child.item_criterion).map(text => /(first|second|third)/u.exec(text)[1]), ['first', 'second', 'third']);
  for (const child of children) assert.equal(child.item_check, CHECK);
});

test('cli.journeys-add-item-size.default-budget-unchanged: clause 2: a board that does not set the setting files and cuts items as on main, with the default of 30 [C7,#2539]', async t => {
  const within = await addSized(t, null, 18);
  assert.equal(within.children.length, 0);
  const over = await addSized(t, null, 40);
  assert.equal(over.children.length, 3);
  assert.deepEqual(over.children.map(child => child.item_expected_build_minutes), [14, 14, 14]);
});
