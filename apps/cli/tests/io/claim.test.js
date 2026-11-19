/** The claim freezer carries the family backlog threshold into the frozen text only for a required-family item with review.relaxRequiredFamily on [C7,#11119]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CELL_CONFIG } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellBoard } from '../../../../packages/board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../packages/store/tests/fixtures/cell.js';
import { getItem } from '../../../../packages/store/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { freezer } from '../../src/io/claim.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';

const BAR = 'The page renders [test]';

/** A real repo whose settings carry verify.familyRelaxAt 2, one claimed web item, and a machine home whose settings turn the relax switch as given. */
function claimed(t, relax) {
  const { root: home } = privateFixtureFiles('pullboard-claim-freezer-');
  fixtureMachineSettings(home, relax === undefined ? {} : { review: { relaxRequiredFamily: relax } });
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before; });
  const repo = cellRepo(t, { real: true, config: { ...CELL_CONFIG, verify: { familyRelaxAt: 2 } } });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true });
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/a` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page', criterion: BAR, specIds: ['G1'] });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const ctx = { info: { root: repo.root, isMain: true }, config: loadConfig(repo.root) };
  return { board, ctx, item: getItem(board, item.item_id) };
}

/** The policy.verify.familyRelaxAt the freezer writes for the item. */
function frozenRelaxAt({ board, ctx }, item) {
  return JSON.parse(freezer(ctx, { board })(item).text).policy?.verify?.familyRelaxAt;
}

test('cli.io-claim.freezer-carries-family-relax-at: clause 1: freezer on an item whose review family is set, with review.relaxRequiredFamily on and verify.familyRelaxAt 2, yields frozen text whose policy.verify.familyRelaxAt is 2 [C7,#11119]', t => {
  const fx = claimed(t, true);
  assert.equal(frozenRelaxAt(fx, { ...fx.item, item_review_family: 'openai' }), 2);
});

test('cli.io-claim.freezer-omits-family-relax-at-when-off: clause 2: with the setting off, or an item with no review family, the frozen text carries no policy.verify.familyRelaxAt [C7,#11119]', t => {
  const off = claimed(t, false);
  assert.equal(frozenRelaxAt(off, { ...off.item, item_review_family: 'openai' }), undefined, 'setting off');
  assert.equal(frozenRelaxAt(claimed(t, undefined), { ...off.item, item_review_family: 'openai' }), undefined, 'setting unset');
  const on = claimed(t, true);
  assert.equal(frozenRelaxAt(on, on.item), undefined, 'no review family');
  assert.equal(Object.hasOwn(JSON.parse(freezer(on.ctx, { board: on.board })(on.item).text), 'policy'), false, 'nothing else changes in the frozen text');
});
