/** @pullboard-test-input source-tree */
/** The default agent loop takes independent work immediately and ends an empty turn [N41,N42,C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_NEXT_STEPS } from '../apps/cli/src/core/next-step-defaults.js';
import { NEXT_STEPS } from '../apps/cli/src/core/next-step-words.js';
import { successfulNext } from '../packages/config/src/core/json-output.js';
import { requireManualLanding } from '../packages/merge/index.js';
import { fixture, cli } from './next-take-fixture.js';
import { fixtureBoard } from './board-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
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
  assert.throws(() => requireManualLanding({}), error => {
    assert.equal(error.code, 'BOARD_LANDS_ACCEPTED');
    assert.doesNotMatch(error.next, /--wait|\bwait\b/iu);
    return true;
  });
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
  const overlapping = box.add('Overlapping build stays blocked');
  const build = box.add('Independent next build', {
    brief: 'Files: web/independent.js\nTest: Native selection claims a separate file while the submitted source awaits review.',
  });
  const taken = await cli(box, box.seats.builder.path, ['next']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.ok(taken.document.item, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, build);
  assert.equal(taken.document.review, false);
  assert.equal(store.getItem(box.board, build).item_owner, box.seats.builder.id);
  assert.equal(store.getItem(box.board, overlapping).item_status, 'open', 'the submitted file still blocks overlapping work');
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
  assert.equal(out.trim(), 'next: nothing for this seat: end your turn', 'one empty-turn action, without a duplicate footer');
  assert.doesNotMatch(out + err, /--wait|next waiting/u);
  assert.ok(Buffer.byteLength(out + err) <= 2048);
  assert.equal(store.getItem(box.board, ownSession).item_review_by, null);
});


test('selection shares the complete relaxation queue per threshold and reservation rechecks current authority [N41,V1,H16,C7]', t => {
  const board = fixtureBoard(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  board.clock = { now: () => new Date(now) };
  for (const [id, family, parent] of [
    ['coordinator', 'human', 'a'], ['core-1', 'openai', 'b'],
    ['core-2', 'openai', 'c'], ['core-3', 'openai', 'd'],
    ['core-4', 'anthropic', 'b'],
  ]) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core',
      path: `/fixture/${id}`, route: 'strong', family, parentDigest: parent.repeat(64), model: 'fixture-model' });
  }
  /** Publish authentic native fixture history without claiming a gate ran. */
  function submitted(builder, threshold) {
    const id = store.addItem(board, { by: 'coordinator', lane: 'core', route: 'strong',
      title: 'Relaxation selection fixture', criterion: 'The independent reviewer retains its exact authority.' });
    const text = JSON.stringify({ policy: { verify: { family: 'require', familyRelaxAt: threshold } } });
    store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: 3_600_000,
      freeze: () => ({ text, digest: createHash('sha256').update(text).digest('hex') }) });
    submitFixture(board, id, { agentId: builder, commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
    return id;
  }
  // The first subjects do not qualify: the foreign sibling can review the first, and the second has a higher frozen threshold.
  const unblocked = submitted('core-3', 2);
  const higherThreshold = submitted('core-1', 10);
  const blocked = Array.from({ length: 6 }, () => submitted('core-1', 2));
  const options = { agentId: 'core-2', lane: 'core', verify: true, policy: 'any', familyPolicy: 'require' };
  const prepare = board.db.prepare.bind(board.db);
  let activityReads = 0;
  board.db.prepare = sql => {
    if (sql.includes('SELECT DISTINCT event.event_by AS id')) activityReads++;
    return prepare(sql);
  };
  t.after(() => { board.db.prepare = prepare; });
  const first = store.nextFor(board, options).item;
  assert.ok(blocked.includes(first?.item_id), 'an initially unblocked subject cannot erase the later subjects relaxation witness');
  assert.notEqual(first.item_id, unblocked);
  assert.notEqual(first.item_id, higherThreshold, 'one subjects lower threshold never changes another frozen threshold');
  assert.ok(activityReads <= 2, `${activityReads} activity reads for two frozen thresholds, not one per subject`);

  // A new eligible foreign reviewer must invalidate the preview at the actual reservation boundary.
  store.register(board, { id: 'core-5', lane: 'core', path: '/fixture/core-5', route: 'strong',
    family: 'anthropic', parentDigest: 'e'.repeat(64), model: 'fixture-model' });
  assert.throws(() => store.reserveReview(board, first.item_id, { ...options, leaseMs: 3_600_000 }), { code: 'SAME_FAMILY' });
  assert.equal(store.getItem(board, first.item_id).item_review_by, null, 'a stale preview grants no reservation');
  activityReads = 0;
  assert.equal(store.nextFor(board, options).item, null, 'a fresh selection sees the newly available reviewer');
  assert.ok(activityReads <= 2, `${activityReads} activity reads after the native queue changed`);

  now = new Date(now.getTime() + 16 * 60_000);
  activityReads = 0;
  const later = store.nextFor(board, options).item;
  assert.ok(later, 'a later selection rederives the activity window instead of retaining an empty result');
  assert.notEqual(later.item_id, higherThreshold);
  assert.ok(activityReads <= 2, `${activityReads} activity reads after the activity window changed`);
});
