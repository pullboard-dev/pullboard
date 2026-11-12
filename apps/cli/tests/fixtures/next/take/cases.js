import { cli } from '../take.js';
import { fixture } from '../take.js';
import {
  bindRefs,
  resolveMove,
} from '../../../../../../packages/outbox/index.js';
import {
  compareMainFailures,
  mainRedReviewItems,
} from '../../../../../../packages/landing/index.js';
/** Real Git, ordered board work and deterministic dispatch boundaries [N2,V1,B3,A6,V2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { main } from '../../native.js';
import { addMilestone } from '../../../../../../packages/store/index.js';

test('a two-minute-old submission interrupts a free builder before the queue ratio [C7,N2,V1]', async t => {
  const box = await fixture(t, { family: 'off' });
  const waiting = box.add('Waiting normal review');
  box.submit(waiting);
  const build = box.add('Otherwise the next build', { brief: 'Files: web/build.js\nTest: independent build remains claimable.' });
  box.advance(2 * 60_000);
  store.appendFact(box.board, waiting, { agentId: 'coordinator', kind: 'note', text: 'A fresh note does not reset submission age.' });
  const offered = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, waiting);
  assert.equal(offered.document.review, true);
  assert.equal(store.getItem(box.board, build).item_status, 'open');
  assert.equal(store.getItem(box.board, waiting).item_review_by, box.seats.actor.id, 'plain next reserves an aged review for its caller');
});

test('review dispatch takes the oldest eligible submission ahead of a newer milestone pin [C7,N2,V1]', async t => {
  const box = await fixture(t);
  const oldest = box.add('Oldest waiting review');
  box.submit(oldest);
  box.advance(60_000);
  const newer = box.add('Newer pinned review');
  box.submit(newer);
  addMilestone(box.board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Pinned current', items: [newer] });
  const offered = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, oldest);
  assert.equal(store.getItem(box.board, newer).item_review_by, null);
});

test('strict review dispatch requires a different vendor even with family policy off [C7,V1,B3]', async t => {
  const box = await fixture(t, { family: 'off' });
  const strict = box.add('Strict explicit-family review', { reviewFamily: 'Family Alpha' });
  box.submit(strict);
  box.advance(11 * 60_000);
  const build = box.add('Eligible work while strict waits');
  const ownVendor = await cli(box, box.seats.sameFamily.path, ['next', '--take']);
  assert.notEqual(ownVendor.document?.item?.item_id, strict, ownVendor.out + ownVendor.err);
  assert.equal(store.getItem(box.board, strict).item_review_by, null);
  const direct = await cli(box, box.seats.sameFamily.path, ['next', '--verify', String(strict)]);
  assert.equal(direct.code, 1, direct.out + direct.err);
  assert.equal(direct.document.error.code, 'SAME_FAMILY');
  assert.match(direct.document.error.message, /another declared vendor family/u);
  assert.equal(store.getItem(box.board, strict).item_review_by, null);
  assert.equal(store.getItem(box.board, build).item_status, 'open');
});


test('strict different-vendor review remains selectable through the shared guards [C7,V1,B3]', async t => {
  const box = await fixture(t, { family: 'off' });
  const strict = box.add('Strict outside-vendor review', { reviewFamily: 'Family Beta' });
  box.submit(strict);
  const offered = await cli(box, box.seats.outside.path, ['next', '--take']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, strict);
  assert.equal(offered.document.review, true);
  assert.equal(store.getItem(box.board, strict).item_review_by, box.seats.outside.id);
});


test('a repair of evidenced current-main failure jumps the review queue and ratio [C7,N2,V1]', async t => {
  const box = await fixture(t, { mainRed: true });
  const older = box.add('Older ordinary submission', { specIds: ['G2'] });
  box.submit(older);
  box.advance(60_000);
  const repair = box.add('Repair the current main failure');
  box.submit(repair);
  const build = box.add('A build that would otherwise win', { specIds: ['G2'], brief: 'Files: web/fresh.js\nTest: the independent build stays claimable before review urgency.' });
  // Node 22's internal runner marker makes a nested --test command return without running its files.
  const testContext = process.env.NODE_TEST_CONTEXT;
  let comparison;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    comparison = await compareMainFailures(box.root, { tests: [{ file: 'test/main-red.test.js', passed: false }] });
  } finally {
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = testContext;
  }
  assert.equal(comparison.unavailable, undefined, JSON.stringify(comparison));
  assert.deepEqual(comparison.files, [{ file: 'test/main-red.test.js', result: 'red' }]);
  assert.deepEqual(mainRedReviewItems(box.root, box.board), [repair]);
  const offered = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.item.item_id, repair);
  assert.equal(offered.document.review, true);
  assert.equal(store.getItem(box.board, build).item_status, 'open');
  const reserved = await cli(box, box.seats.actor.path, ['next', '--verify']);
  assert.equal(reserved.code, 0, reserved.out + reserved.err);
  assert.equal(reserved.document.item.item_id, repair);
  assert.equal(store.getItem(box.board, older).item_review_by, null);
  assert.equal(store.getItem(box.board, repair).item_review_by, box.seats.actor.id);
});


test('captured main-red review priority follows offline item renumbering [C7,B26,H16]', () => {
  const outbox = { moves: [{ move: { id: 'offline-add', operation: 'addItem', args: [{}] }, visible: 7 }],
    results: { 'offline-add': 12 } };
  const move = { id: 'review', operation: 'reserveNextReview', args: [{ agentId: 'core-1', priority: [7, 9], skipIds: [7] }] };
  const entry = { move, refs: bindRefs(outbox, move) };
  const sent = resolveMove(entry, outbox);
  assert.deepEqual(sent.lost, []);
  assert.deepEqual(sent.move.args[0].priority, [12, 9]);
  assert.deepEqual(sent.move.args[0].skipIds, [12]);
  assert.deepEqual(move.args[0].priority, [7, 9], 'the sealed original remains unchanged');
});


test('default next resumes its held review below the queue ratio before a fresh build [C7,N2,V1]', async t => {
  const box = await fixture(t);
  const review = box.add('Review already held by this seat');
  box.submit(review);
  const actor = box.seats.actor;
  store.reserveReview(box.board, review, { agentId: actor.id, leaseMs: 3_600_000, policy: 'any', familyPolicy: 'off' });
  const build = box.add('Independent fresh build', { brief: 'Files: web/new-build.js\nTest: existing review remains the seat priority.' });
  const next = await cli(box, actor.path, ['next']);
  assert.equal(next.code, 0, next.out + next.err);
  assert.equal(next.document.item.item_id, review);
  assert.equal(next.document.review, true);
  assert.equal(store.getItem(box.board, review).item_review_by, actor.id, 'the review stays reserved to its holder');
  assert.equal(store.getItem(box.board, build).item_status, 'open');
});


test('sensitive reviews without a required family refuse same-vendor offers and explicit reservation [C7,V4,B26]', async t => {
  const box = await fixture(t, { family: 'off' });
  const strict = box.add('Sensitive native tier without a family', { sensitive: true, reviewFamily: null });
  box.submit(strict);
  box.advance(11 * 60_000);
  const build = box.add('Fresh work while sensitive review waits');
  for (const args of [['next'], ['next', '--take']]) {
    const offered = await cli(box, box.seats.sameFamily.path, args);
    assert.notEqual(offered.document?.item?.item_id, strict, offered.out + offered.err);
    assert.equal(store.getItem(box.board, strict).item_review_by, null);
  }
  const refused = await cli(box, box.seats.sameFamily.path, ['next', '--verify', String(strict)]);
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.equal(refused.document.error.code, 'SAME_FAMILY');
  assert.match(refused.document.error.message, /another declared vendor family/u);
  assert.equal(store.getItem(box.board, build).item_status, 'open');
  const outside = await cli(box, box.seats.outside.path, ['next', '--take']);
  assert.equal(outside.code, 0, outside.out + outside.err);
  assert.equal(outside.document.item.item_id, strict);
  assert.equal(store.getItem(box.board, strict).item_review_by, box.seats.outside.id);
});


test('standard review with vendor policy off remains available to another session of the same vendor [C7,V4,B26]', async t => {
  const box = await fixture(t, { family: 'off' });
  const standard = box.add('Standard same-vendor independent session', { sensitive: false, reviewFamily: null });
  box.submit(standard);
  box.advance(11 * 60_000);
  const preview = await cli(box, box.seats.sameFamily.path, ['next']);
  assert.equal(preview.code, 0, preview.out + preview.err);
  assert.equal(preview.document.item.item_id, standard);
  assert.equal(store.getItem(box.board, standard).item_review_by, box.seats.sameFamily.id, 'plain next reserves the review for the caller');
  const taken = await cli(box, box.seats.sameFamily.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, standard);
  assert.equal(store.getItem(box.board, standard).item_review_by, box.seats.sameFamily.id);
});
