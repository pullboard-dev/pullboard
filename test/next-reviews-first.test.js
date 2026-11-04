/** @pullboard-test-input source-tree */
/** next --take gives every eligible seat a green, unreserved review before any build [C7,#2992]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { fixture, cli } from './next-take-fixture.js';

/** Record a green gate at the item's submitted head, the way the submit queue does. */
function green(box, id) {
  const head = store.getItem(box.board, id).item_commit;
  box.board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(`submit_handoff:${id}`, JSON.stringify({ commit: head, agentId: box.seats.builder.id, state: 'green' }));
}

test('a seat with a green unreserved submission reviews it before any build, with no starvation wait [C7,#2992]', async t => {
  const box = await fixture(t);
  const review = box.add('Green submission waiting one minute'); box.submit(review);
  const build = box.add('Open build', { brief: 'Files: web/other.js\nTest: an independent build stays open.' });
  green(box, review);
  box.advance(60_000);
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.review, true, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, review);
  assert.equal(store.getItem(box.board, review).item_review_by, box.seats.actor.id);
  assert.equal(store.getItem(box.board, build).item_status, 'open', 'no build claim before the review');
});

test('the cross-family rule still decides who takes a green review [C7,#2992]', async t => {
  const box = await fixture(t, { family: 'require' });
  const review = box.add('Green submission from Family Alpha'); box.submit(review);
  const build = box.add('Open build', { brief: 'Files: web/other.js\nTest: an independent build stays open.' });
  green(box, review);
  const same = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(same.code, 0, same.out + same.err);
  assert.notEqual(same.document.review, true, 'a same-family seat is not given the review: ' + same.out);
  assert.equal(store.getItem(box.board, build).item_owner, box.seats.actor.id, 'the same-family seat builds instead');
  assert.equal(store.getItem(box.board, review).item_review_by, null);
  const other = await cli(box, box.seats.outside.path, ['next', '--take']);
  assert.equal(other.code, 0, other.out + other.err);
  assert.equal(other.document.review, true, other.out + other.err);
  assert.equal(other.document.item.item_id, review);
});

test('plain next also takes a one-minute green review before a build, below the ten-minute starvation wait [C7,#2992]', async t => {
  const box = await fixture(t);
  const review = box.add('Green submission below the starvation wait'); box.submit(review);
  const build = box.add('Open build', { brief: 'Files: web/other.js\nTest: an independent build stays open.' });
  green(box, review);
  box.advance(60_000);
  const taken = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.review, true, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, review);
  assert.equal(store.getItem(box.board, build).item_status, 'open', 'no build claim before the review');
});
