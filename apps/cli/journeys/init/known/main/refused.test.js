/** Real affected-case known-main refusals: a red only on the item still refuses at the pulled gate [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { rows } from '../../../../tests/fixtures/affected.js';
import { settledSubmit } from '../../../../tests/fixtures/affected.js';

test('an affected case red only on the item still refuses [V4,B3]', async t => {
  const box = fixture(t, { main: 1, candidate: 2 });
  const settled = await settledSubmit(t, box, { submitted: false });
  assert.equal(settled.submission, null, 'a case red only on the item records no submit');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
