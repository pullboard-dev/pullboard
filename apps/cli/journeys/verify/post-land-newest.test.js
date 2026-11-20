/** next --verify offers landed items newest landing first [C7,#9864]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../tests/fixtures/land/failure.js';
import { landedBy } from '../../tests/fixtures/land/failure.js';
import { BUILDER } from '../../tests/fixtures/verify/post-land-order.js';
import { OTHER } from '../../tests/fixtures/verify/post-land-order.js';
import { offerLandedReviews } from '../../tests/fixtures/verify/post-land-order.js';
import { offeredTo } from '../../tests/fixtures/verify/post-land-order.js';
import { seatOf } from '../../tests/fixtures/verify/post-land-order.js';

test('cli.journeys-verify-post-land-newest.two-landed-items-are-offered-newest: clause 2: two landed items are offered newest landing first [C7,#9864]', async t => {
  const box = await fixture(t);
  const older = await landedBy(box, t, { family: `${BUILDER} A`, name: 'Landed older' });
  const newer = await landedBy(box, t, { family: `${BUILDER} B`, name: 'Landed newer' });
  offerLandedReviews(box);
  const other = await seatOf(box, OTHER);
  assert.equal(await offeredTo(other), newer, 'the newest landing is offered first');
  const accepted = await other('verify', String(newer), 'accept', '--no-next', '--note', 'read the merge diff against the bar', '--json');
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  assert.equal(await offeredTo(other), older, 'the older landing follows');
});
