/** A second review release by one model family holds the item for the coordinator through the real CLI, with review.holdAfterTwoReleases on [C7,#10933]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../../../packages/config/index.js';
import { TESTKIT_MODEL } from '../../../fixtures/testkit.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

/** Turn review.holdAfterTwoReleases on in the fixture's machine settings, as the other release journeys set theirs. */
function holdOn() {
  const settings = machineSettingsFile();
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')), review: { holdAfterTwoReleases: true } }));
}

/** A review-lane seat of its own model family and parent session, joined through the real command beside the fixture's seats. */
async function reviewSeat(box, name, family, parent) {
  const path = join(dirname(box.seats.actor.path), name);
  box.git(box.root, 'worktree', 'add', '-q', '-b', `review/${name}`, path);
  const joined = await cli(box, path, ['join', 'review', '--model', TESTKIT_MODEL, '--family', family, '--parent', parent]);
  assert.equal(joined.code, 0, joined.out + joined.err);
  return { path };
}

/** The builder's submitted item, and three review seats of one family (gamma) beside one of another (delta). */
async function submitted(t) {
  const box = await fixture(t);
  const id = box.add('Item two reviewers hand back', { route: 'mid' });
  box.submit(id);
  const gamma = [];
  for (const name of ['one', 'two', 'three']) gamma.push(await reviewSeat(box, `gamma-${name}`, 'Family Gamma', `fixture-G${name}`));
  return { box, id, gamma, delta: await reviewSeat(box, 'delta', 'Family Delta', 'fixture-D') };
}

/** The review lease mark of a just-reserved review lasts five seconds on the fixture clock; a second reviewer asks after it has run out, so the journey advances that clock past the mark before each ask. */
const PAST_LEASE_MS = 6_000;

/** `pullboard next --verify <id>` as `seat` asks for the review once the lease mark of the last reservation has run out. */
async function nextVerify(box, seat, id) {
  box.advance(PAST_LEASE_MS);
  return cli(box, seat.path, ['next', '--verify', String(id)]);
}

/** Take the review with `pullboard next --verify <id>` as `seat`, then drop it with `pullboard release <id> --reason OTHER --note ...`. */
async function dropReview(box, seat, id) {
  const taken = await nextVerify(box, seat, id);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, id);
  const released = await cli(box, seat.path, ['release', String(id), '--reason', 'OTHER', '--note', 'no time to judge this one', '--no-next']);
  assert.equal(released.code, 0, released.out + released.err);
}

/** The coordinator shouts about this item's hold after two releases. */
const holdShouts = (box, id) => box.board.db.prepare('SELECT shout_text FROM shout WHERE shout_to = ?').all('coordinator').filter(row => row.shout_text.includes(`#${id} held after two releases`));

test('cli.journeys-release-review-twice.holds: clause 1: with review.holdAfterTwoReleases on, two pullboard release review releases (taken with pullboard next --verify) by two seats of one family leave the item held by the coordinator with one coordinator shout [C7,#10933]', async t => {
  const { box, id, gamma } = await submitted(t);
  holdOn();
  await dropReview(box, gamma[0], id);
  assert.equal(store.getItem(box.board, id).item_hold_by, null, 'one review release holds nothing');
  await dropReview(box, gamma[1], id);
  const item = store.getItem(box.board, id);
  assert.equal(item.item_hold_by, 'coordinator');
  assert.match(item.item_hold_reason, /^Review released twice without a verdict/u);
  assert.equal(holdShouts(box, id).length, 1, 'one coordinator shout');
});

test('cli.journeys-release-review-twice.family-refused: clause 2: after pullboard hold --off, a pullboard next --verify claim by a third seat of that family is refused REVIEW_RELEASE_TWICE with its next step, while a seat of another family takes the review [C7,#10933]', async t => {
  const { box, id, gamma, delta } = await submitted(t);
  holdOn();
  await dropReview(box, gamma[0], id);
  await dropReview(box, gamma[1], id);
  const lifted = await cli(box, box.root, ['hold', String(id), '--off']);
  assert.equal(lifted.code, 0, lifted.out + lifted.err);
  const refused = await nextVerify(box, gamma[2], id);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out + refused.err, /REVIEW_RELEASE_TWICE/u);
  assert.match(refused.out + refused.err, /next/u, 'the refusal names its next step');
  const taken = await nextVerify(box, delta, id);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, id);
});

test('cli.journeys-release-review-twice.off-unchanged: clause 3: with review.holdAfterTwoReleases off (default), both review releases only free the review and the item stays unheld, as on main [C7,#10933]', async t => {
  const { box, id, gamma } = await submitted(t);
  await dropReview(box, gamma[0], id);
  await dropReview(box, gamma[1], id);
  const item = store.getItem(box.board, id);
  assert.equal(item.item_hold_by, null);
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_review_by, null, 'the review is free');
  assert.equal(holdShouts(box, id).length, 0);
});
