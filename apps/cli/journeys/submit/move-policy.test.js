/** A pulled submit still refuses when pullboard.json policy changes while its gate runs [V4,H16,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/submit/move.js';
import { item } from '../../tests/fixtures/submit/move.js';

test('pulled submit still refuses when pullboard.json policy changes during its gate [V4,H16,C7]', async t => {
  const { box, output } = await fixture(t, 'policy');
  // A pulled gate has no composition step at the receipt; the sealed policy check refuses the changed proof field.
  assert.match(output, /NO_POLICY/u);
  assert.match(output, /accepted submit policy changed: affectedTests/u);
  assert.notEqual(item(box).item_status, 'submitted', output);
});

test('pulled submit refuses when a non-submit pullboard.json policy field changes during its gate [V4,H16,C7]', async t => {
  const { box, output } = await fixture(t, 'shared', true);
  assert.notEqual(item(box).item_status, 'submitted', output);
  assert.match(output, /NO_POLICY/u);
  assert.match(output, /accepted submit policy changed: shared/u);
});
