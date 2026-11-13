/** After a parser failure blocked its batch, the next landing lands the other accepted item [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/land/failure.js';
import { landOnce } from '../../../../tests/fixtures/land/failure.js';

test('clause 2: the next landing lands the other independently accepted item without adopting the parser failure [C7]', async t => {
  const box = await fixture(t, { duplicate: true, unrelated: true });
  assert.equal((await landOnce(box)).batch.state, 'blocked'); // only culprits came back [C7,#4265]
  let next;
  for (let attempt = 0; attempt < 2 && box.itemOf(box.other).item_status !== 'landed' && !box.itemOf(box.other).item_merged_commit; attempt++) {
    next = await landOnce(box);
    assert.doesNotMatch(JSON.stringify(next.landJob?.receipt ?? next), /LAND_ADOPT|LAND_MODULE_PARSE/u);
  }
  assert.ok(box.itemOf(box.other).item_merged_commit, 'the unrelated item reached main');
  assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), box.before);
  assert.equal(box.git(box.repo, 'show', 'main:web/other.txt'), 'source change');
  assert.equal(box.itemOf(box.item).item_status, 'open');
});
