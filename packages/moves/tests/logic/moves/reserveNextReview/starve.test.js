/** Real native eligibility and dispatch keep strict reviews from starving [C7,N2,V1,A6]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../../../fixtures/next.js';
import { next } from '../../../fixtures/next.js';
import * as store from '../../../../../store/index.js';
import { healthReport } from '../../../../../health/index.js';
import { defaults } from '../../../../../config/index.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';
import { configProblems } from '../../../../../config/index.js';

/** Observe actual health against the fixture's immutable source and injected native clock. */
function health(box, config = box.config) {
  return healthReport({ db: box.board.db, root: box.root, config, now: box.clock.now(),
    dispatchHealth: () => ({ findings: [] }) });
}

test('moves.reserve-next-review-starve.an-eligible-idle-agent-gets-an-eleven-minute: an eligible idle agent gets an eleven-minute strict review before a build while its builder gets the build [C7,N2,V1]', async t => {
  const box = fixture(t, { reviewers: true });
  const waiting = box.add('Strict review waiting eleven minutes', { reviewFamily: 'Family Beta' });
  box.submit(waiting);
  const build = box.add('Separate available build', { brief: 'Files: web/other.js\nTest: a genuinely independent build remains open.' });
  box.advance(11 * 60_000);
  const before = store.events(box.board);
  const finding = health(box).stuck.find(entry => entry.cause === 'REVIEW_STARVED' && entry.item === waiting);
  assert.ok(finding, 'the default five-minute threshold includes strict reviews');
  assert.equal(finding.detail.ageMs, 11 * 60_000);
  assert.ok(finding.detail.eligible.includes(box.seats.outside.id));
  assert.deepEqual(store.events(box.board), before, 'health never writes board state');
  box.as('outside');
  const offered = await next(box);
  assert.equal(offered.item.item_id, waiting);
  assert.equal(offered.review, true);
  assert.equal(store.getItem(box.board, build).item_status, 'open');
  box.as('builder');
  const builder = await next(box);
  assert.equal(builder.item.item_id, build, 'canonical self-review exclusion is preserved');
});

test('moves.reserve-next-review-starve.a-free-seat-takes-the-oldest-eligible: clause 1: a free seat takes the oldest eligible review after two minutes regardless of the build ratio [C7,#3077]', async t => {
  const box = fixture(t, { reviewers: true });
  const oldest = box.add('Oldest review waiting two minutes');
  box.submit(oldest);
  box.advance(60_000);
  const newer = box.add('Newer review');
  box.submit(newer);
  const build = box.add('Open build while reviews wait', { brief: 'Files: web/other.js\nTest: the unrelated build remains open.' });
  box.advance(60_000);
  box.as('outside');
  const offered = await next(box);
  assert.equal(offered.item.item_id, oldest);
  assert.equal(offered.review, true);
  assert.equal(store.getItem(box.board, build).item_status, 'open');
});

test('moves.reserve-next-review-starve.health-names-the-exact-native-check-when: health names the exact native check when every joined seat is excluded from a starved review [C7,A6,V1]', t => {
  const box = fixture(t, { reviewers: true });
  const waiting = box.add('Strict review with policy blocking its outside seats', { reviewFamily: 'Family Beta' });
  box.submit(waiting);
  box.advance(11 * 60_000);
  const report = health(box, { ...box.config, verify: { ...box.config.verify, policy: 'coordinator' } });
  const finding = report.stuck.find(entry => entry.cause === 'REVIEW_STARVED' && entry.item === waiting);
  assert.ok(finding);
  assert.equal(finding.detail.ageMs, 11 * 60_000);
  assert.deepEqual(finding.detail.eligible, []);
  assert.ok(finding.detail.excluding.some(entry => entry.code === 'COORDINATOR_VERIFIES'));
  assert.match(finding.why, /COORDINATOR_VERIFIES/u, 'the report names the failing native check rather than inventing a reviewer');
});

test('moves.reserve-next-review-starve.a-review-starved-finding-listing-500-seats-keeps: clause 1: a REVIEW_STARVED finding listing 500 seats keeps a why under the 8192 receipt cap and states the omitted seats [C7,A6,V1]', t => {
  const box = fixture(t, { reviewers: true });
  const waiting = box.add('Strict review with five hundred excluded seats', { reviewFamily: 'Family Beta' });
  box.submit(waiting);
  for (let n = 0; n < 500; n++) {
    const path = join(box.project.dir, `crowd-${n}`);
    mkdirSync(path);
    cellSeat(box.board, { lane: 'review', path, family: 'Family Beta' });
  }
  box.advance(11 * 60_000);
  const report = health(box, { ...box.config, verify: { ...box.config.verify, policy: 'coordinator' } });
  const finding = report.stuck.find(entry => entry.cause === 'REVIEW_STARVED' && entry.item === waiting);
  assert.ok(finding);
  assert.ok(finding.detail.excluding.length >= 500, 'the structured detail still lists every excluded seat');
  assert.ok(finding.why.length <= 8192, `the why is ${finding.why.length} characters`);
  const omitted = /and (\d+) more seats omitted/u.exec(finding.why);
  assert.ok(omitted, 'the why states how many seats it left out');
  assert.ok(Number(omitted[1]) > 50);
  assert.equal(store.normalizedHealthFindings([finding]).length, 1, 'the receipt accepts the truncated finding');
});

test('moves.reserve-next-review-starve.configured-starvation-waits-select-the-oldest-eligible: configured starvation waits select the oldest eligible review for a held builder after a reservation expires [C7,N2,V1]', t => {
  const box = fixture(t, { reviewers: true });
  const oldest = box.add('Oldest strict review', { reviewFamily: 'Family Beta' });
  box.submit(oldest);
  store.reserveReview(box.board, oldest, { agentId: box.seats.outside.id, leaseMs: 1_000, policy: 'any' });
  box.advance(11 * 60_000);
  const newer = box.add('Newer strict review', { reviewFamily: 'Family Beta' });
  box.submit(newer);
  const held = box.add('Held build uses the configured urgent threshold', { lane: 'review' });
  box.claim(held, box.seats.outside);
  const who = { agentId: box.seats.outside.id, lane: 'review', ratio: 99, starveMinutes: 20 };
  assert.equal(store.reviewOffer(box.board, who), null, 'configured twenty-minute wait has not elapsed');
  box.advance(10 * 60_000);
  const offer = store.reviewOffer(box.board, who);
  assert.equal(offer.item.item_id, oldest, 'a past reservation does not suppress a still-unclaimed review forever');
  assert.equal(offer.urgent, 'age');
  store.reserveReview(box.board, oldest, { agentId: box.seats.outside.id, leaseMs: 60_000, policy: 'any' });
  const other = store.reviewOffer(box.board, { ...who, agentId: box.seats.sibling.id, starveMinutes: 10 });
  assert.notEqual(other?.item.item_id, oldest, 'a live reservation stays exclusive');
  const configured = defaults();
  assert.equal(configured.review.starveMinutes, 5);
  configured.review.starveMinutes = -1;
  assert.ok(configProblems(configured).some(problem => problem.includes('review.starveMinutes')));
});
