/** After a parser failure blocked its batch, the next landing does not adopt it again [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/land/failure.js';
import { landOnce } from '../../../../tests/fixtures/land/failure.js';

test('clause 2: the next landing proceeds without adopting the same parser failure again [C7]', async t => {
  const box = await fixture(t, { duplicate: true });
  assert.equal((await landOnce(box)).batch.state, 'blocked'); // only culprits came back [C7,#4265]
  const next = await landOnce(box);
  assert.doesNotMatch(JSON.stringify(next.landJob?.receipt ?? next), /LAND_ADOPT|LAND_MODULE_PARSE/u);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), box.before);
});
