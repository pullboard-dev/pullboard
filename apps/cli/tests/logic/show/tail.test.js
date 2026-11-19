/** show's submitted, review hold, merged and withdrawn lines come from one pure function, with the exact text the full path printed before [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tailLines } from '../../../src/logic/show/tail.js';

const OPEN = { item_id: 7 };
const SUBMITTED = { item_id: 8, item_commit: 'abc1234', item_builder_family: 'anthropic', item_review_until: '2026-11-18 20:00' };
const MERGED = { item_id: 9, item_commit: 'def5678', item_effective_head: 'eee9999', item_merged_commit: 'fff0000' };
const WITHDRAWN = { item_id: 10, item_withdrawn_reason: 'landed by hand' };

test('cli.logic-show-tail.tail-lines-match-the-recorded-text: clause 1: tailLines returns the submitted-by, checked-main-merge, infra note, under-review, merged-as and withdrawn lines exactly as show printed them for an open, a submitted, a verified and a withdrawn item [C7]', () => {
  assert.deepEqual(tailLines(OPEN), { before: [], mergedAs: null, withdrawn: null }, 'an open item prints none of them');
  const infra = { note: 'runner lost', files: ['a.js', 'b.js'] };
  assert.deepEqual(tailLines(SUBMITTED, { builderName: 'core-1', reviewerName: 'core-2', infra }), {
    before: [
      'submitted by core-1 [family anthropic] at abc1234',
      'infra note: runner lost (files: a.js, b.js)',
      'under review by core-2 until 2026-11-18 20:00',
    ],
    mergedAs: null,
    withdrawn: null,
  });
  assert.deepEqual(tailLines(SUBMITTED, { builderName: 'core-1', infra: { note: 'n', files: [] } }).before, [
    'submitted by core-1 [family anthropic] at abc1234',
    'infra note: n (files: none)',
  ]);
  assert.deepEqual(tailLines(MERGED, { builderName: 'core-1' }), {
    before: ['submitted by core-1 at def5678', 'checked main merge: eee9999 (original submitted source and verdict retained)'],
    mergedAs: 'merged as fff0000',
    withdrawn: null,
  });
  assert.deepEqual(tailLines(WITHDRAWN), { before: [], mergedAs: null, withdrawn: 'withdrawn: landed by hand' });
});
