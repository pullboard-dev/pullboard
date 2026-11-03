/** @pullboard-test-input source-tree */
/** The default agent loop takes independent work immediately and ends an empty turn [N41,N42,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_NEXT_STEPS } from '../apps/cli/src/core/next-step-defaults.js';
import { NEXT_STEPS } from '../apps/cli/src/core/next-step-words.js';
import { successfulNext } from '../packages/config/src/core/json-output.js';
import { fixture, cli } from './next-take-fixture.js';
import { main } from './native-cli-fixture.js';
import * as store from '../packages/store/index.js';

test('defaults, move refusals and the init loop never suggest a timed wait [N42,C7]', () => {
  for (const [code, step] of Object.entries({ ...DEFAULT_NEXT_STEPS, ...NEXT_STEPS })) {
    assert.doesNotMatch(step, /--wait/iu, code);
    assert.doesNotMatch(step, /\bwait (?:for|until|on)\b/iu, code);
  }
  const template = readFileSync(new URL('../packages/config/src/shell/templates.js', import.meta.url), 'utf8');
  assert.doesNotMatch(template, /--wait/u);
  assert.match(template, /next, build or review, commit, submit, next/u);
  assert.match(template, /When next has nothing for your seat, end your turn/u);
  assert.equal(successfulNext('submit', {}), 'pullboard next');
  assert.equal(successfulNext('next', {}), 'nothing for this seat: end your turn');
});

test('plain next reserves an eligible review before a build, even with a held build [N41,V1,C7]', async t => {
  const box = await fixture(t);
  const build = box.add('Build available now');
  const review = box.add('Review available now', { criterion: 'Large frozen bar. '.repeat(2000) });
  box.submit(review);
  const seat = box.seats.actor;
  const first = await cli(box, seat.path, ['next']);
  assert.equal(first.code, 0, first.out + first.err);
  assert.equal(first.document.item.item_id, review);
  assert.equal(first.document.review, true);
  assert.equal(store.getItem(box.board, review).item_review_by, seat.id);
  assert.equal(store.getItem(box.board, build).item_status, 'open');
  assert.ok(Buffer.byteLength(first.out + first.err) <= 2048, 'the frozen packet belongs in show, not next');

  // A real pre-existing claim does not turn a ready review into a mere unreserved offer.
  box.claim(build, seat);
  const again = await cli(box, seat.path, ['next']);
  assert.equal(again.code, 0, again.out + again.err);
  assert.equal(again.document.review, true);
  assert.equal(again.document.item.item_id, review);
  assert.equal(store.getItem(box.board, build).item_owner, seat.id);
});

test('plain next skips the builders own submitted source and claims other work [N41,V1,C7]', async t => {
  const box = await fixture(t);
  const submitted = box.add('Already submitted');
  box.submit(submitted);
  const build = box.add('Independent next build');
  const taken = await cli(box, box.seats.builder.path, ['next']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, build);
  assert.equal(taken.document.review, false);
  assert.equal(store.getItem(box.board, build).item_owner, box.seats.builder.id);
  assert.equal(store.getItem(box.board, submitted).item_status, 'submitted');
  assert.equal(store.getItem(box.board, submitted).item_review_by, null);
  assert.ok(Buffer.byteLength(taken.out + taken.err) <= 2048);
});

test('an empty plain next exits zero with a bounded end-turn answer in text and JSON [N41,N42,C7]', async t => {
  const box = await fixture(t, { family: 'require' });
  const ownSession = box.add('Ineligible review');
  box.submit(ownSession);
  const seat = box.seats.sibling;
  const json = await cli(box, seat.path, ['next']);
  assert.equal(json.code, 0, json.out + json.err);
  assert.equal(json.document.item, null);
  let out = '', err = '';
  const code = await main(['next'], { cwd: seat.path, clock: box.clock,
    stdout: { isTTY: false, write: part => { out += part; } },
    stderr: { write: part => { err += part; } } });
  assert.equal(code, 0, out + err);
  assert.match(out, /nothing for this seat: end your turn/u);
  assert.doesNotMatch(out + err, /--wait|next waiting/u);
  assert.ok(Buffer.byteLength(out + err) <= 2048);
  assert.equal(store.getItem(box.board, ownSession).item_review_by, null);
});
