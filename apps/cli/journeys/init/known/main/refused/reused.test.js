/** A recorded main red is reused while a new head failure still refuses at the pulled gate [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../../tests/fixtures/affected.js';
import { rows } from '../../../../../tests/fixtures/affected.js';
import { settledSubmit } from '../../../../../tests/fixtures/affected.js';

test('a recorded main red is reused while a new head failure still refuses [V4,B3,C7]', async t => {
  const affected = `import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
test('inherited failure [G1]', () => assert.equal(1, 2));
test('new head failure [G1]', () => assert.equal(existsSync('change.txt'), false));
`;
  const box = fixture(t, { affected });
  const first = await settledSubmit(t, box, { submitted: false });
  assert.equal(first.submission, null, 'the new head failure records no submit');
  const second = await settledSubmit(t, box, { submitted: false });
  assert.equal(second.submission, null, 'the recorded main red does not excuse the new head failure');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
