/** With review.releaseReasons on, a review release needs one of the four reasons; off, it is as before [C7,#8921]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../../../packages/config/index.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

const NOTE = 'Dropping this review because the fixture needs a free reviewer.';

/** A fixture whose actor seat holds the review of one submitted item; releaseReasons is set as asked. */
async function held(t, releaseReasons) {
  const box = await fixture(t, { seats: ['actor', 'builder'] });
  writeFileSync(machineSettingsFile(), JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false },
    review: { releaseReasons } }));
  const id = box.add('Review reason item');
  box.submit(id);
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(store.getItem(box.board, id).item_review_by, box.seats.actor.id, 'the actor holds the review');
  return { box, id };
}

test('cli.journeys-release-review-reason-required.with-review-releasereasons-on-a-review: clause 1: with review.releaseReasons on, a review release with no reason or an outside reason is refused naming the four [C7,#8921]', async t => {
  const { box, id } = await held(t, true);
  for (const extra of [[], ['--reason', 'OTHER']]) {
    const refused = await cli(box, box.seats.actor.path, ['release', String(id), '--note', NOTE, ...extra]);
    assert.notEqual(refused.code, 0, 'the release is refused');
    assert.equal(refused.document.error.code, 'REVIEW_RELEASE_REASON');
    const text = refused.document.error.message + refused.document.error.next;
    for (const reason of ['BAR', 'FAMILY', 'INFRA', 'TOO_LARGE']) assert.match(text, new RegExp(reason, 'u'), `the refusal names ${reason}`);
    assert.equal(store.getItem(box.board, id).item_review_by, box.seats.actor.id, 'the review is still held');
  }
  const accepted = await cli(box, box.seats.actor.path, ['release', String(id), '--note', NOTE, '--reason', 'too large']);
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  assert.equal(store.getItem(box.board, id).item_review_by, null);
});

test('cli.journeys-release-review-reason-required.review-releasereasons-is-off-by-default: clause 2: review.releaseReasons is off by default and, off, a review release with a reason outside the four works as today [C7,#8921]', async t => {
  const { box, id } = await held(t, false);
  const released = await cli(box, box.seats.actor.path, ['release', String(id), '--note', NOTE, '--reason', 'OTHER']);
  assert.equal(released.code, 0, released.out + released.err);
  assert.equal(store.getItem(box.board, id).item_review_by, null);
});
