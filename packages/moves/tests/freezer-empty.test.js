/** @pullboard-test-input source-cell packages/moves packages/config */
/** freeze.refuseEmptyBar: on, no item freezes with an empty criterion; off (the default), it freezes as before [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { criterionFreezer } from '../index.js';
import { describeSetting } from '../../config/index.js';

const BLANKS = ['', '  \n', undefined];

test('moves.freeze.refuse-empty-bar-on: clause 1: with freeze.refuseEmptyBar on, freezing a blank criterion is refused BAR_EMPTY with its next step [C7]', () => {
  const freeze = criterionFreezer({ root: '/nowhere', isMain: false, config: {} }, { refuseEmpty: true });
  for (const item_criterion of BLANKS) {
    assert.throws(() => freeze({ item_id: 1908, item_criterion }), error => error.code === 'BAR_EMPTY' && /#1908/u.test(error.message) && /numbered clauses/u.test(error.next));
  }
});

test('moves.freeze.refuse-empty-bar-off: clause 2: with freeze.refuseEmptyBar off (the default), a blank criterion is not refused BAR_EMPTY, and the setting is described [C7]', () => {
  const freeze = criterionFreezer({ root: '/nowhere', isMain: false, config: {} }, { refuseEmpty: false });
  for (const item_criterion of BLANKS) {
    try { freeze({ item_id: 1908, item_criterion }); } catch (error) { assert.notEqual(error.code, 'BAR_EMPTY'); }
  }
  const described = describeSetting('freeze.refuseEmptyBar');
  assert.ok(described.label, 'the setting carries a plain label');
  assert.match(described.description, /BAR_EMPTY/u);
  assert.equal(described.unit, 'on/off');
});

test('moves.freeze.refuse-unnumbered-bar-on: clause 1: with freeze.refuseEmptyBar on, a criterion with text but no numbered clause is refused BAR_EMPTY, and a numbered one is not [C7,#3521]', () => {
  const freeze = criterionFreezer({ root: '/nowhere', isMain: false, config: {} }, { refuseEmpty: true });
  for (const item_criterion of ['The page loads and shows the board.', 'Several outcomes. One after another. No numbers.']) {
    assert.throws(() => freeze({ item_id: 3521, item_criterion }), error => error.code === 'BAR_EMPTY' && /#3521/u.test(error.message) && /no numbered clause/u.test(error.message) && /numbered clauses/u.test(error.next), item_criterion);
  }
  try { freeze({ item_id: 3521, item_criterion: '1. The page loads [test]' }); } catch (error) { assert.notEqual(error.code, 'BAR_EMPTY', 'a numbered bar passes the empty-bar check'); }
});

test('moves.freeze.refuse-unnumbered-bar-off: clause 2: with freeze.refuseEmptyBar off (the default), an unnumbered criterion is not refused BAR_EMPTY [C7,#3521]', () => {
  const freeze = criterionFreezer({ root: '/nowhere', isMain: false, config: {} }, { refuseEmpty: false });
  for (const item_criterion of ['The page loads and shows the board.', 'Several outcomes. One after another. No numbers.']) {
    try { freeze({ item_id: 3521, item_criterion }); } catch (error) { assert.notEqual(error.code, 'BAR_EMPTY', item_criterion); }
  }
});
