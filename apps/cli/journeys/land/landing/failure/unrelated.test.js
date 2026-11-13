/** A parser failure blocks its batch but keeps an unrelated accepted verdict [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/land/failure.js';
import { landOnce } from '../../../../tests/fixtures/land/failure.js';

test('clause 1: the blocked batch keeps an unrelated accepted verdict while charging only the implicated item [C7]', async t => {
  const box = await fixture(t, { duplicate: true, unrelated: true });
  const settled = await landOnce(box);
  assert.match(JSON.stringify(settled.landJob.receipt), /LAND_MODULE_PARSE/u);
  assert.equal(box.itemOf(box.item).item_status, 'open', 'the implicated item goes back to open');
  assert.equal(box.itemOf(box.other).item_status, 'verified', 'the unrelated accepted verdict is preserved');
});
