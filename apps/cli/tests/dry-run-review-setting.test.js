/** The bar.dryRunReview line setting takes off, on and ab, off by default, and ab records each item's arm [C7,#8631]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileFixtureItem } from '../../../packages/gate/tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../../packages/gate/tests/fixtures/testkit.js';
import { validateLineSetting } from '../../../packages/queue/index.js';
import { dryRunReviewArm } from '../../../packages/verify/index.js';
import { dryRunReviewMode } from '../../../packages/verify/index.js';

/** A board stub holding only the board_meta table, with the setting stored as JSON when given. */
function boardWith(stored) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  if (stored !== undefined) db.prepare('INSERT INTO board_meta VALUES (?, ?)').run('line_setting:bar.dryRunReview', JSON.stringify(stored));
  return { db };
}

test('cli.dry-run-review-setting.bar-dryrunreview-accepts-off-on-and-ab: clause 1: bar.dryRunReview accepts off, on and ab, with off the default [C7]', () => {
  for (const value of [false, true, 'ab']) validateLineSetting('bar.dryRunReview', value);
  for (const value of ['yes', 'on', 1, null]) assert.throws(() => validateLineSetting('bar.dryRunReview', value), { code: 'LINE_SETTING_RANGE' });
  assert.throws(() => validateLineSetting('bar.check', 'ab'), { code: 'LINE_SETTING_RANGE' }, 'ab belongs to the dry-run review setting alone');
  assert.equal(dryRunReviewMode(boardWith()), false, 'an unset board is off');
  assert.equal(dryRunReviewMode(boardWith(true)), true);
  assert.equal(dryRunReviewMode(boardWith('ab')), 'ab');
  assert.throws(() => dryRunReviewMode(boardWith('maybe')), { code: 'LINE_SETTING_RANGE' });
});

test('cli.dry-run-review-setting.with-ab-each-submitted-item-receives-one: clause 2: with ab each submitted item receives one recorded arm, on or off, and the arms alternate [C7]', () => {
  assert.equal(dryRunReviewArm(false, 8631), null, 'off records no arm');
  assert.equal(dryRunReviewArm(true, 8631), 'on');
  const arms = [8630, 8631, 8632, 8633].map(id => dryRunReviewArm('ab', id));
  assert.deepEqual(arms, ['on', 'off', 'on', 'off']);
  assert.equal(dryRunReviewArm('ab', 8631), dryRunReviewArm('ab', 8631), 'the same item always gets the same arm');
});

test('cli.dry-run-review-setting.under-ab-submitting-two-items-on-a: clause 2: under ab, submitting two items on a real board writes each item its recorded arm note [C7]', async t => {
  const { createE2eHelpers } = await import('./fixtures/e2e.js');
  const { join } = await import('node:path');
  const fixtures = createE2eHelpers();
  t.after(fixtures.cleanup);
  const box = fixtures.project('true');
  const numbers = { windowMinutes: 60, activeReviewers: 2, reviewWaitMedianMinutes: 40 };
  const set = await box.runLocal(box.repo, 'settings', 'line', 'bar.dryRunReview', 'ab', '--reason', 'Measure the dry-run review', '--window', JSON.stringify(numbers), '--json');
  assert.equal(set.code, 0, set.err + set.out);
  const seen = new Set();
  for (const title of ['First arm', 'Second arm']) {
    const { item_id: id } = await fileFixtureItem(box, box.repo, { lane: 'web', title, args: ['--specs', 'G1'], wait: true, run: box.runLocal });
    const seat = join(box.dir, `arm-${id}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', seat, 'main');
    await joinFixtureSeat(box, seat, 'web', { run: box.runLocal });
    const claimed = await box.runLocal(seat, 'claim', String(id));
    assert.equal(claimed.code, 0, claimed.err + claimed.out);
    // The arm note is written before any readiness refusal, so it exists whether or not this submit goes through.
    await box.runLocal(seat, 'submit', String(id), '--no-next');
    const shown = JSON.parse((await box.runLocal(seat, 'show', String(id), '--json', '--no-next')).out);
    const arms = shown.thread.map(row => row.text ?? '').filter(text => text.startsWith('dry-run review arm: '));
    assert.deepEqual(arms, [`dry-run review arm: ${dryRunReviewArm('ab', id)}`], `item #${id} records exactly the arm it received`);
    seen.add(dryRunReviewArm('ab', id));
  }
  assert.equal(seen.size, 2, 'two consecutive items receive both arms');
});
