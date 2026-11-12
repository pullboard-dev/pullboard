/** A refusal of one item's own content halves the next batch, so a blocked pair is not adopted forever [C7,#2901,#2967]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemRefusalText } from '../../src/logic/refusal.js';
import { batchOutcome } from '../../src/logic/batch/size.js';

test('a dirty merge from a cells-plan placement is the item\'s own; a dirty merge for another reason is not [C7]', () => {
  assert.equal(itemRefusalText('LAND_DIRTY', 'landing batch x left its worktree dirty again: canonical state rule placement failed for packages/state/data/history/233.json; repair the cells plan and retry'), true);
  assert.equal(itemRefusalText('LAND_DIRTY', 'landing batch x left its worktree dirty again'), false);
  assert.equal(itemRefusalText('LAND_PLAN_UNPLACED', ''), true);
  assert.equal(itemRefusalText('BOARD_BUSY', 'the board file remained held'), false);
  assert.equal(itemRefusalText('GATE_RED', 'static checks are red; fix the named source'), true);
});

test('a batch blocked by an item refusal counts as a failure for the sizer; a machinery refusal says nothing [C7]', () => {
  const blocked = refusal => ({ state: 'blocked', items: [{ id: 1 }, { id: 2 }], refusal });
  assert.equal(batchOutcome(blocked({ code: 'LAND_DIRTY', message: 'canonical state rule placement failed for packages/state/data/history/233.json; repair the cells plan and retry' })), false);
  assert.equal(batchOutcome(blocked({ code: 'LAND_DIRTY', message: 'left its worktree dirty again' })), null);
  assert.equal(batchOutcome(blocked({ code: 'SLOT_DB_LOCKED', message: 'the slot database is locked' })), null);
  assert.equal(batchOutcome({ state: 'landed', items: [{ id: 1 }] }), true);
});
