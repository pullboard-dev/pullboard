/** Family cover is native routing advice; it never weakens the independent reservation guards [C7,#3076]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { repoInfo } from '../../../../../../packages/git/index.js';
import { registerSeatWake } from '../../../../../../packages/seats/index.js';
import { REVIEW_WAKE_WAIT_MS } from '../../../../../../packages/sentinels/index.js';
import {
  REVIEW_COVER_WAIT_MS,
  reviewFamilyCover,
  reviewFamilyBuildPause,
} from '../../../../../../packages/health/index.js';
import { shoutConflictedReviews } from '../../../../../../packages/health/index.js';
import { submitFixture } from '../../../../tests/fixtures/board/submit.js';
import {
  cli,
  fixture,
} from '../../../../tests/fixtures/next/take.js';

/** Seed explicitly synthetic green board state at actual reachable fixture Git objects. */
async function reviewFamilyFixture(t, count = 3) {
  const box = await fixture(t, { family: 'require' });
  // Presence and queue age are independent: seats already idle when these submissions arrive.
  box.advance(11 * 60_000);
  const info = repoInfo(box.root);
  const head = box.git(box.seats.builder.path, 'rev-parse', 'HEAD');
  const tree = box.git(box.root, 'rev-parse', `${head}^{tree}`);
  const waiting = [];
  for (let index = 0; index < count; index++) {
    const id = box.add(`Awaiting independent review ${index}`, { route: 'strong', brief: 'Files: web/ready.js\nTest: the review stays available.' });
    box.claim(id);
    submitFixture(box.board, id, { agentId: box.seats.builder.id, commit: head, tree, gateGreen: true });
    waiting.push(id);
  }
  return { ...box, info, waiting };
}

/** Register a real private executable for an independent fixture seat, without executing a review. */
function enrollWake(box, seat = box.seats.outside) {
  const executable = join(box.root, '..', `cover-wake-${seat.id}.mjs`);
  writeFileSync(executable, `#!${process.execPath}
process.exitCode = 0;
`);
  chmodSync(executable, 0o755);
  registerSeatWake(repoInfo(seat.path), store.boardId(box.board), seat.id, executable);
}

test('clause 2: three waiting green reviews are reported at five minutes, with an explanation, and builds continue [C7,#3076,#3792]', async t => {
  const box = await reviewFamilyFixture(t);
  const candidate = box.add('New build waits for independent cover', { route: 'strong', brief: 'Files: web/candidate.js\nTest: the review stays available.' });
  assert.equal(REVIEW_WAKE_WAIT_MS, REVIEW_COVER_WAIT_MS, 'sweep and build advice use the same five-minute deadline');
  box.advance(REVIEW_COVER_WAIT_MS - 1);
  assert.equal(reviewFamilyBuildPause(box.info, box.board, box.config, box.seats.actor), null);
  box.advance(1);
  assert.match(reviewFamilyBuildPause(box.info, box.board, box.config, box.seats.actor), /3 waiting green reviews.*another family/u);
  // Builds never wait on review cover [#3792]: next claims the candidate and the backlog is shouted instead.
  const next = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(next.document.item.item_id, candidate);
  assert.equal(store.getItem(box.board, candidate).item_status, 'claimed');
});

test('next --take retains existing claims and still reserves an eligible independent review during a cover pause [C7,#3076]', async t => {
  const box = await reviewFamilyFixture(t);
  const held = box.add('Existing work keeps its lease', { route: 'strong', brief: 'Files: web/held.js\nTest: the review stays available.' });
  box.claim(held, box.seats.actor);
  box.advance(REVIEW_COVER_WAIT_MS);
  const resumed = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(resumed.code, 0, resumed.out + resumed.err);
  assert.equal(resumed.document.item.item_id, held);
  assert.equal(resumed.document.held, true);
  store.release(box.board, held, box.seats.actor.id, 'Fixture returns held work.', 'OTHER');
  const review = box.add('An independent review stays available', { lane: 'review', route: 'strong', brief: 'Files: review/ready.js\nTest: the review stays available.' });
  box.claim(review, box.seats.outside);
  box.git(box.seats.outside.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'review source with a parent');
  const head = box.git(box.seats.outside.path, 'rev-parse', 'HEAD');
  submitFixture(box.board, review, { agentId: box.seats.outside.id, commit: head,
    tree: box.git(box.root, 'rev-parse', `${head}^{tree}`), gateGreen: true });
  const reserved = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(reserved.code, 0, reserved.out + reserved.err);
  assert.equal(reserved.document.item.item_id, review);
  assert.equal(reserved.document.review, true);
});

test('a wakeable or currently live independent reviewer restores family build cover [C7,#3076]', async t => {
  const box = await reviewFamilyFixture(t);
  box.advance(REVIEW_COVER_WAIT_MS);
  assert.ok(reviewFamilyBuildPause(box.info, box.board, box.config, box.seats.actor));
  store.heartbeatSeat(box.board, box.seats.outside.id);
  assert.equal(reviewFamilyBuildPause(box.info, box.board, box.config, box.seats.actor), null, 'actual current heartbeat restores cover');
  box.advance(11 * 60_000);
  assert.ok(reviewFamilyBuildPause(box.info, box.board, box.config, box.seats.actor));
  enrollWake(box);
  assert.equal(reviewFamilyBuildPause(box.info, box.board, box.config, box.seats.actor), null, 'registered independent wake restores cover');
});

test('same-parent wake capabilities never count as independent family cover [C7,#3076]', async t => {
  const box = await reviewFamilyFixture(t);
  box.advance(REVIEW_COVER_WAIT_MS);
  enrollWake(box, box.seats.sibling);
  assert.ok(reviewFamilyBuildPause(box.info, box.board, box.config, box.seats.actor), 'another vendor in the author parent session is still ineligible');
});

test('clause 3: doctor names missing registered family wakes and clears each restored family [C7,#3076]', async t => {
  const box = await reviewFamilyFixture(t, 1);
  const family = store.canonicalFamily(box.board, 'Family Alpha');
  assert.ok(reviewFamilyCover(box.info, box.board, box.config).missingFamilies.includes(family));
  const doctor = await cli(box, box.root, ['doctor']);
  assert.ok(doctor.document.problems.some(problem => problem.code === 'REVIEW_FAMILY_COVER' && problem.message.startsWith(family)));
  enrollWake(box);
  const restored = await cli(box, box.root, ['doctor']);
  assert.equal(restored.document.problems.some(problem => problem.code === 'REVIEW_FAMILY_COVER' && problem.message.startsWith(family)), false);
});

/** Add item-conflicted greens (the independent seat claimed them first) and a spare review that keeps that seat busy. */
async function conflictFixture(t, { fresh, conflicted = 1 }) {
  const box = await reviewFamilyFixture(t, fresh);
  const head = box.git(box.seats.builder.path, 'rev-parse', 'HEAD');
  const tree = box.git(box.root, 'rev-parse', `${head}^{tree}`);
  const green = (title, first) => {
    const id = box.add(title, { route: 'strong', brief: 'Files: web/ready.js\nTest: the review stays available.' });
    box.claim(id);
    // Synthetic history: the independent seat once submitted this item at a real commit, so item-authors refuses it as a reviewer.
    if (first) store.logEvent(box.board, first.id, 'submit', id, { commit: head, gateGreen: false, fixture: 'earlier submission by the independent seat' });
    submitFixture(box.board, id, { agentId: box.seats.builder.id, commit: head, tree, gateGreen: true });
    return id;
  };
  const refused = Array.from({ length: conflicted }, (_, index) => green(`Item-conflicted review ${index}`, box.seats.outside));
  const spare = green('Spare review the independent seat is busy with');
  store.heartbeatSeat(box.board, box.seats.outside.id);
  store.reserveReview(box.board, spare, { agentId: box.seats.outside.id, leaseMs: 60 * 60_000, policy: 'any', familyPolicy: 'require' });
  box.advance(REVIEW_COVER_WAIT_MS);
  store.heartbeatSeat(box.board, box.seats.outside.id);
  return { ...box, refused };
}

test('clause 1: two fresh greens plus one item-conflicted review do not pause builds [C7,#3086,#3741]', async t => {
  const box = await conflictFixture(t, { fresh: 2 });
  const rows = reviewFamilyCover(box.info, box.board, box.config).waiting;
  assert.deepEqual(rows.filter(row => row.conflicted).map(row => row.item.item_id), box.refused, 'only the item-conflicted review is set aside');
  assert.equal(reviewFamilyBuildPause(box.info, box.board, box.config, box.seats.actor), null);
});

test('clause 1: three renderable greens still pause builds beside an item-conflicted one [C7,#3086,#3741]', async t => {
  const box = await conflictFixture(t, { fresh: 3 });
  assert.match(reviewFamilyBuildPause(box.info, box.board, box.config, box.seats.actor), /3 waiting green reviews/u);
});

test('clause 1: the coordinator hears about an item-conflicted review once, not again while it is unchanged [C7,#3086,#3741]', async t => {
  const box = await conflictFixture(t, { fresh: 2 });
  const ctx = { info: box.info, config: box.config, clock: box.clock };
  const ordered = async (_ctx, board, operation, args) => store[operation](board, ...args);
  assert.deepEqual(await shoutConflictedReviews(ctx, box.board, ordered), box.refused);
  assert.deepEqual(await shoutConflictedReviews(ctx, box.board, ordered), []);
  const all = box.board.db.prepare('SELECT shout_from, shout_to, shout_text FROM shout').all();
  const heard = all.filter(row => row.shout_to === 'coordinator' && row.shout_text.startsWith(`#${box.refused[0]} is green`)).length;
  assert.equal(heard, 1, JSON.stringify(all));

});

test('clause 2: a cover backlog no longer stops next --build [C7,#3741,#3792]', async t => {
  const box = await reviewFamilyFixture(t);
  const held = box.add('Held by the coordinator', { route: 'strong', brief: 'Files: web/held.js\nTest: the review stays available.' });
  store.holdItem(box.board, held, { agentId: 'coordinator', reason: 'Fixture hold' });
  box.add('New build waits for independent cover', { route: 'strong', brief: 'Files: web/candidate.js\nTest: the review stays available.' });
  box.advance(REVIEW_COVER_WAIT_MS);
  const pause = reviewFamilyBuildPause(box.info, box.board, box.config, box.seats.actor);
  assert.ok(pause);
  // The pause wording is advice only [#3792]: next --build still hands out the build.
  const next = await cli(box, box.seats.actor.path, ['next', '--build']);
  assert.ok(next.document.item, 'a build is handed out despite the cover backlog');
});
