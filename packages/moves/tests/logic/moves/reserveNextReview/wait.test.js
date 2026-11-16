/** Builders never wait on review cover: the backlog is shouted to the coordinator instead [C7,#3792]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { REVIEW_COVER_WAIT_MS } from '../../../../../health/index.js';
import { submitFixture } from '../../../../../store/tests/fixtures/submit.js';
import { fixture } from '../../../fixtures/next.js';
import { next } from '../../../fixtures/next.js';

/** Three green same-family submissions with no independent reviewer, aged past the old pause deadline. */
function backlogFixture(t) {
  const box = fixture(t, { family: 'require', reviewers: true });
  box.advance(11 * 60_000);
  const head = box.git('rev-parse', 'HEAD');
  const tree = box.git('rev-parse', `${head}^{tree}`);
  const waiting = [];
  for (let index = 0; index < 3; index++) {
    const id = box.add(`Awaiting independent review ${index}`, { route: 'strong', brief: 'Files: web/ready.js\nTest: the review stays available.' });
    box.claim(id);
    submitFixture(box.board, id, { agentId: box.seats.builder.id, commit: head, tree, gateGreen: true });
    waiting.push(id);
  }
  const candidate = box.add('Next build despite the backlog', { route: 'strong', brief: 'Files: web/candidate.js\nTest: the review stays available.' });
  box.advance(REVIEW_COVER_WAIT_MS);
  return { box, waiting, candidate };
}

/** The Stuck review-cover shouts to one recipient. */
function stuckShouts(box, to = 'coordinator') {
  return box.board.db.prepare("SELECT shout_text FROM shout WHERE shout_to=? AND shout_text LIKE 'Stuck: review cover.%'").all(to);
}

test('clause 1: next hands a builder its next item with green reviews waiting and no other-family reviewer [C7,#3792]', async t => {
  const { box, candidate } = backlogFixture(t);
  const found = await next(box);
  assert.equal(found.item.item_id, candidate);
  assert.equal(store.getItem(box.board, candidate).item_status, 'claimed');
});

test('clause 2: the Stuck shout reaches the coordinator and the person with the count and missing family, and repeats only when the count grows [C7,#3792]', async t => {
  const { box, waiting } = backlogFixture(t);
  const first = await next(box);
  assert.ok(first.item, JSON.stringify(first));
  for (const to of ['coordinator', 'person']) {
    const shouts = stuckShouts(box, to);
    assert.equal(shouts.length, 1, `${to}: ${JSON.stringify(shouts)}`);
    assert.match(shouts[0].shout_text, new RegExp(` has ${waiting.length} green items waiting for review`, 'u'));
    assert.match(shouts[0].shout_text, /no live or wakeable .+ reviewer/u);
  }
  box.add('A second build while the backlog is unchanged', { route: 'strong', brief: 'Files: web/second.js\nTest: the review stays available.' });
  store.release(box.board, first.item.item_id, box.seats.actor.id, 'Fixture frees the seat.', 'OTHER');
  const second = await next(box);
  assert.ok(second.item, JSON.stringify(second));
  assert.equal(stuckShouts(box).length, 1, 'an unchanged count is not shouted again');
  const head = box.git('rev-parse', 'HEAD');
  const tree = box.git('rev-parse', `${head}^{tree}`);
  const more = box.add('One more green review', { route: 'strong', brief: 'Files: web/ready.js\nTest: the review stays available.' });
  box.claim(more);
  submitFixture(box.board, more, { agentId: box.seats.builder.id, commit: head, tree, gateGreen: true });
  store.release(box.board, second.item.item_id, box.seats.actor.id, 'Fixture frees the seat.', 'OTHER');
  box.add('A third build after the count grew', { route: 'strong', brief: 'Files: web/third.js\nTest: the review stays available.' });
  const third = await next(box);
  assert.ok(third.item, JSON.stringify(third));
  assert.equal(stuckShouts(box).length, 2, 'a grown count is shouted again');
  assert.match(stuckShouts(box)[1].shout_text, / has 4 green items/u);
});

test("clause 2: another family's earlier larger count does not hide this family's Stuck shout [C7,#3792]", async t => {
  const { box, waiting } = backlogFixture(t);
  store.shout(box.board, { from: 'sentinel', to: 'coordinator', lanes: [], text: 'Stuck: review cover. otherfamily has 9 green items waiting for review and no live or wakeable anthropic reviewer. Wake or add one; builds continue.' });
  const found = await next(box);
  assert.ok(found.item, JSON.stringify(found));
  const shouts = stuckShouts(box).filter(row => !row.shout_text.includes('otherfamily'));
  assert.equal(shouts.length, 1, JSON.stringify(stuckShouts(box)));
  assert.match(shouts[0].shout_text, new RegExp(` has ${waiting.length} green items waiting for review`, 'u'));
});
