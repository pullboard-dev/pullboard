/** A parser failure in a composed landing blocks its batch and charges the implicated item, not the train [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fixture } from '../../../tests/fixtures/land/failure.js';
import { landOnce } from '../../../tests/fixtures/land/failure.js';

test('clause 1: a duplicate import in the composed landing blocks its batch and returns the implicated item, main unmoved [C7]', async t => {
  const box = await fixture(t, { duplicate: true });
  const settled = await landOnce(box);
  const output = JSON.stringify(settled.landJob.receipt);
  assert.equal(settled.batch.state, 'blocked');
  assert.match(output, /LAND_MODULE_PARSE/u);
  assert.match(output, /web\/client\.js/u);
  assert.equal(box.itemOf(box.item).item_status, 'open', 'the implicated item goes back to open');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), box.before);
  assert.equal(existsSync(box.marker), false);
});
