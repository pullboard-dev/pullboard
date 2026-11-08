/** Family cover is native routing advice; it never weakens the independent reservation guards [C7,#3076]. */
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { repoInfo } from '../packages/git/index.js';
import { registerSeatWake } from '../packages/seats/index.js';
import { REVIEW_WAKE_WAIT_MS } from '../packages/sentinels/index.js';
import { REVIEW_COVER_WAIT_MS, reviewFamilyCover, reviewFamilyBuildPause } from '../packages/health/index.js';
import { submitFixture } from './board-submit-fixture.js';
import { cli, fixture } from './next-take-fixture.js';

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

test('clause 2: three waiting green reviews pause new builds at five minutes, with an explanation and no claim [C7,#3076]', async t => {
  const box = await reviewFamilyFixture(t);
  const candidate = box.add('New build waits for independent cover', { route: 'strong', brief: 'Files: web/candidate.js\nTest: the review stays available.' });
  assert.equal(REVIEW_WAKE_WAIT_MS, REVIEW_COVER_WAIT_MS, 'sweep and build advice use the same five-minute deadline');
  box.advance(REVIEW_COVER_WAIT_MS - 1);
  assert.equal(reviewFamilyBuildPause(box.info, box.board, box.config, box.seats.actor), null);
  box.advance(1);
  assert.match(reviewFamilyBuildPause(box.info, box.board, box.config, box.seats.actor), /3 waiting green reviews.*another family/u);
  for (const args of [['next'], ['next', '--build'], ['next', '--take']]) {
    const next = await cli(box, box.seats.actor.path, args);
    assert.equal(next.document.item ?? null, null, args.join(' '));
    if (args.length === 1) {
      // Plain next is the never-waiting default loop: it ends the turn with the reason instead of refusing.
      assert.match(next.document.next, /end your turn/u, args.join(' '));
      assert.match(next.document.reasons.join(' '), /independent review cover/u, args.join(' '));
      continue;
    }
    assert.equal(next.document.error.code, 'NOTHING_FREE', args.join(' '));
    assert.match(next.document.error.message, /independent review cover/u);
  }
  assert.equal(store.getItem(box.board, candidate).item_status, 'open');
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
