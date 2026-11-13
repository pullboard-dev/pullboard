/** Opted-in automatic repairs of identical unowned main failures, settled through the pulled gate [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fixture,
  cli,
  rows,
  settledSubmit,
} from '../../../../../tests/fixtures/affected.js';

test('opted-in submit files one linked repair for an identical unowned main failure [V4,B3]', async t => {
  const box = fixture(t, { autoFileMainReds: true });
  const generic = cli(box, box.builder, 'add', 'core', 'Unrelated repair', '--criterion', 'Not a derived repair.');
  assert.equal(generic.status, 1);
  assert.equal(JSON.parse(generic.stdout).error.code, 'AGENT_GRANT_ITEM', 'the opt-in never widens ordinary creation');
  // The pulled gate judges the red against main's receipt; the board files the repair from accepted main's opt-in [V4,B3,C7].
  const report = await settledSubmit(t, box);
  const repairs = rows(box, "SELECT * FROM item WHERE item_title LIKE 'Main red:%'");
  assert.equal(repairs.length, 1);
  assert.ok(repairs[0].item_criterion.includes(box.main));
  assert.ok(repairs[0].item_criterion.includes('affected case [G1]'));
  assert.ok(repairs[0].item_criterion.includes(`submit #${box.item}`));
  assert.ok(repairs[0].item_check.includes('test/affected.test.js'));
  assert.equal(report.gate.green, false, 'the original red never becomes a green run');
  assert.equal(report.submission?.gateGreen, true, 'the submission is green only over main\'s own case');
  assert.deepEqual(report.submission.submissionProof.knownMainFailures.failures.map(row => row.item), [repairs[0].item_id]);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
  const asked = rows(box, 'SELECT * FROM shout').filter(row => row.shout_to === 'coordinator' && row.shout_decision === 1);
  assert.equal(asked.length, 0, 'a filed repair owns the red, so the coordinator is not asked');
});
