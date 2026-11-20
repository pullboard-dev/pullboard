/** add and edit refuse a test bar importing another cell's fixture, behind items.barRulesAtAdd [C7,#11740]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { requireCellTestFixture } from '../../../../src/io/item/bar.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const LISTED = 'packages/board/tests/fixtures/cell-board.js';

/** A fixture repo whose main holds the cell-test listing naming one pure helper, returned as a context the bar check reads. */
function mainWithListing() {
  const box = helpers.project('true', helpers.sandbox());
  const file = 'packages/gate/data/tests/test-cells.json';
  mkdirSync(dirname(join(box.repo, file)), { recursive: true });
  writeFileSync(join(box.repo, file), JSON.stringify({ pureHelpers: { [LISTED]: 'listed' } }));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: fixture');
  return { info: { root: box.repo } };
}

const bar = (test, fixture) => ({ criterion: `1. packages/api/src/io/x.js is proved by ${test} [test]`, check: `node --test ${test}`, brief: `Files:\n- ${fixture}` });
const TEST = 'packages/api/tests/io/x.test.js';

test('cli.io-item-bar-fixture.refuses-another-cells-fixture: clause 1: with items.barRulesAtAdd on, a bar naming a test and an unlisted fixture of another cell is refused CELL_TEST_FIXTURE [C7,#11740]', async () => {
  await assert.rejects(requireCellTestFixture(mainWithListing(), bar(TEST, 'packages/gate/tests/fixtures/chrome.js'), true), error => {
    assert.equal(error.code, 'CELL_TEST_FIXTURE');
    assert.match(error.message, /packages\/gate\/tests\/fixtures\/chrome\.js/u);
    return true;
  });
});

test('cli.io-item-bar-fixture.names-the-legal-routes: clause 2: the refusal names the own-cell fixture, the lower front door, the leaf front door and the listed pure helper routes [C7,#11740]', async () => {
  await assert.rejects(requireCellTestFixture(mainWithListing(), bar(TEST, 'apps/cli/tests/fixtures/chrome/x.js'), true), error => {
    assert.equal(error.code, 'CELL_TEST_FIXTURE');
    for (const route of [/own cell/u, /front door of a cell below/u, /leaf cell's front door/u, /pure helper listed/u]) assert.match(error.next, route);
    return true;
  });
});

test('cli.io-item-bar-fixture.accepts-own-cell-listed-or-off: clause 3: with the setting off, or a fixture of the test own cell or a listed pure helper, the bar is accepted [C7,#11740]', async () => {
  const ctx = mainWithListing();
  await requireCellTestFixture(ctx, bar(TEST, 'packages/gate/tests/fixtures/chrome.js'), false);
  await requireCellTestFixture(ctx, bar(TEST, 'packages/api/tests/fixtures/registry-11740.json'), true);
  await requireCellTestFixture(ctx, bar(TEST, LISTED), true);
  await requireCellTestFixture(ctx, bar(TEST, 'packages/gate/tests/fixtures/chrome.js'), true, true);
});
