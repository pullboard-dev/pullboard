/** An affected case that fails differently on the item than on main still refuses at the pulled gate [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../../tests/fixtures/affected.js';
import { rows } from '../../../../../tests/fixtures/affected.js';
import { settledSubmit } from '../../../../../tests/fixtures/affected.js';

test('an affected case that fails differently on the item than on main refuses [V4,B3,C7]', async t => {
  const box = fixture(t, { main: 2, candidate: 3, criterion: 'test/affected.test.js retains its behavior.' });
  const settled = await settledSubmit(t, box, { submitted: false });
  assert.equal(settled.submission, null, 'a red that differs from main records no submit');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
