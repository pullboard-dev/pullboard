/** A claim freezes the board's pace into the item once, so an item keeps the pace it was admitted under [V2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CELL_CONFIG } from '../../../store/tests/fixtures/cell.js';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { getItem } from '../../../store/index.js';
import { loadConfig } from '../../../config/index.js';
import { criterionFreezer } from '../../index.js';
import { itemPace } from '../../index.js';

const BAR = 'The page renders [test]';

/** A real repo whose committed settings carry `pace`, a board, and one claimed web item. */
function claimed(t, pace) {
  const repo = cellRepo(t, { real: true, config: { ...CELL_CONFIG, ...(pace ? { pace } : {}) } });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true });
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/a` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page', criterion: BAR, specIds: ['G1'] });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  return { repo, board, item: getItem(board, item.item_id) };
}

/** Freeze the stored item again the way a later move does: a recompute, or a refreeze when `refreeze` is set. */
function refrozen({ repo, board, item }, refreeze = false) {
  return criterionFreezer({ root: repo.root, isMain: true, config: loadConfig(repo.root) }, { board, captureVerifyPolicy: refreeze })(item);
}

test('moves.pace.freeze-sprint-recorded: clause 1: a first claim under pace sprint records pace sprint in the item\'s frozen policy [V2]', t => {
  const fx = claimed(t, 'sprint');
  assert.equal(JSON.parse(fx.item.item_frozen).pace, 'sprint');
  assert.equal(itemPace(fx.item), 'sprint');
});

test('moves.pace.freeze-survives-switch: clause 2: switching the pace setting after the claim leaves the item\'s frozen pace unchanged [V2]', t => {
  const fx = claimed(t, 'sprint');
  fx.repo.put('pullboard.json', JSON.stringify({ ...CELL_CONFIG, pace: 'steady' }, null, 2) + '\n');
  fx.repo.commitAll();
  assert.equal(loadConfig(fx.repo.root).pace, 'steady', 'the board setting has moved');
  const again = refrozen(fx);
  assert.equal(JSON.parse(again.text).pace, 'sprint');
  assert.equal(again.digest, fx.item.item_frozen_digest, 'the recomputed bar keeps its digest');
  assert.equal(JSON.parse(refrozen(fx, true).text).pace, 'sprint', 'a refreeze keeps the admitted pace too');
  assert.equal(itemPace({ item_frozen: again.text }), 'sprint');
});

test('moves.pace.legacy-reads-steady: clause 3: an item frozen before this change reads its pace as steady [V2]', t => {
  const fx = claimed(t, null);
  const frozen = JSON.parse(fx.item.item_frozen);
  assert.equal(Object.hasOwn(frozen, 'pace'), false, 'a steady freeze writes the same bar text as before paces');
  assert.equal(itemPace(fx.item), 'steady');
  const before = JSON.stringify({ ...frozen, pace: undefined });
  assert.equal(itemPace({ item_frozen: before }), 'steady');
  assert.equal(itemPace({ item_frozen: null }), 'steady');
  assert.equal(itemPace({ item_frozen: JSON.stringify({ policy: { verify: { familyRelaxAt: 2 } } }) }), 'steady', 'a legacy pinned policy carries no pace');
  fx.repo.put('pullboard.json', JSON.stringify({ ...CELL_CONFIG, pace: 'sprint' }, null, 2) + '\n');
  fx.repo.commitAll();
  assert.equal(JSON.parse(refrozen(fx).text).pace, undefined, 'turning sprint on later never reaches an item already frozen');
});
