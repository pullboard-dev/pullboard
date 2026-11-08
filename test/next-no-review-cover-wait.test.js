/** Builders never wait on review cover: the backlog is shouted to the coordinator instead [C7,#3792]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { REVIEW_COVER_WAIT_MS } from '../packages/health/index.js';
import { submitFixture } from './board-submit-fixture.js';
import { cli, fixture } from './next-take-fixture.js';

/** Three green same-family submissions with no independent reviewer, aged past the old pause deadline. */
async function backlogFixture(t) {
  const box = await fixture(t, { family: 'require' });
  box.advance(11 * 60_000);
  const head = box.git(box.seats.builder.path, 'rev-parse', 'HEAD');
  const tree = box.git(box.root, 'rev-parse', `${head}^{tree}`);
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

/** The Stuck review-cover shouts to the coordinator. */
function stuckShouts(box) {
  return box.board.db.prepare("SELECT shout_text FROM shout WHERE shout_to='coordinator' AND shout_text LIKE 'Stuck: review cover.%'").all();
}

test('clause 1: next hands a builder its next item with green reviews waiting and no other-family reviewer [C7,#3792]', async t => {
  const { box, candidate } = await backlogFixture(t);
  const next = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(next.code, 0, next.out + next.err);
  assert.equal(next.document.item.item_id, candidate);
  assert.equal(store.getItem(box.board, candidate).item_status, 'claimed');
});

test('clause 2: the same condition raises one Stuck shout naming the waiting items and the missing family, once while unchanged [C7,#3792]', async t => {
  const { box, waiting } = await backlogFixture(t);
  const first = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(first.code, 0, first.out + first.err);
  const shouts = stuckShouts(box);
  assert.equal(shouts.length, 1, JSON.stringify(shouts));
  for (const id of waiting) assert.match(shouts[0].shout_text, new RegExp(`#${id}\\b`, 'u'));
  assert.match(shouts[0].shout_text, /no live or wakeable .+ reviewer/u);
  box.add('A second build while the backlog is unchanged', { route: 'strong', brief: 'Files: web/second.js\nTest: the review stays available.' });
  store.release(box.board, first.document.item.item_id, box.seats.actor.id, 'Fixture frees the seat.', 'OTHER');
  const second = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(second.code, 0, second.out + second.err);
  assert.equal(stuckShouts(box).length, 1, 'an unchanged backlog is not shouted again');
});
