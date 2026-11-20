/** next --verify offers a submitted item before any landed one [C7,#9864]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/land/failure.js';
import { landedBy } from '../../tests/fixtures/land/failure.js';
import { BUILDER } from '../../tests/fixtures/verify/post-land-order.js';
import { OTHER } from '../../tests/fixtures/verify/post-land-order.js';
import { offerLandedReviews } from '../../tests/fixtures/verify/post-land-order.js';
import { offeredTo } from '../../tests/fixtures/verify/post-land-order.js';
import { seatOf } from '../../tests/fixtures/verify/post-land-order.js';

test('cli.journeys-verify-post-land-order.with-landed-reviews-on-a-submitted: clause 1: with landed reviews on, a submitted item is offered before any landed item [C7,#9864]', async t => {
  const box = await fixture(t);
  await landedBy(box, t, { family: `${BUILDER} A`, name: 'Landed older' });
  await landedBy(box, t, { family: `${BUILDER} B`, name: 'Landed newer' });
  const submitted = await landedBy(box, t, { family: `${BUILDER} C`, name: 'Submitted, not landed', land: false });
  offerLandedReviews(box);
  const other = await seatOf(box, OTHER);
  assert.equal(await offeredTo(other), submitted, 'the submitted item comes before every landed item');
});
