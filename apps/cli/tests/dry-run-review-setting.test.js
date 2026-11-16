/** The bar.dryRunReview line setting takes off, on and ab, off by default, and ab records each item's arm [C7,#8631]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
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

test('clause 1: bar.dryRunReview accepts off, on and ab, with off the default [C7]', () => {
  for (const value of [false, true, 'ab']) validateLineSetting('bar.dryRunReview', value);
  for (const value of ['yes', 'on', 1, null]) assert.throws(() => validateLineSetting('bar.dryRunReview', value), { code: 'LINE_SETTING_RANGE' });
  assert.throws(() => validateLineSetting('bar.check', 'ab'), { code: 'LINE_SETTING_RANGE' }, 'ab belongs to the dry-run review setting alone');
  assert.equal(dryRunReviewMode(boardWith()), false, 'an unset board is off');
  assert.equal(dryRunReviewMode(boardWith(true)), true);
  assert.equal(dryRunReviewMode(boardWith('ab')), 'ab');
  assert.throws(() => dryRunReviewMode(boardWith('maybe')), { code: 'LINE_SETTING_RANGE' });
});

test('clause 2: with ab each submitted item receives one recorded arm, on or off, and the arms alternate [C7]', () => {
  assert.equal(dryRunReviewArm(false, 8631), null, 'off records no arm');
  assert.equal(dryRunReviewArm(true, 8631), 'on');
  const arms = [8630, 8631, 8632, 8633].map(id => dryRunReviewArm('ab', id));
  assert.deepEqual(arms, ['on', 'off', 'on', 'off']);
  assert.equal(dryRunReviewArm('ab', 8631), dryRunReviewArm('ab', 8631), 'the same item always gets the same arm');
});
