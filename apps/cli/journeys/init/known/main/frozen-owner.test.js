/** A frozen-check case red identically on main is main-owned at the pulled gate: an unowned one asks the coordinator, an owned one links its repair [V4,B3,C7]. */
import '../../../../index.js'; // This test invokes the real CLI through its public executable.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cli,
  fileMainRed,
  fixture,
  rows,
  settledSubmit,
} from '../../../../tests/fixtures/init/known-frozen.js';

test('a frozen case red identically on main with no owner records a green gate listing it main-owned, shouts, and files nothing [V4,B3,C7]', async t => {
  const box = fixture(t);
  const report = await settledSubmit(t, box, { submitted: true });
  // Since #3534 the gate records green over main's own reds and names them, instead of a builder fact.
  assert.equal(report.submission?.gateGreen, true, 'a red only in main\'s own case records green: ' + JSON.stringify(report.gate));
  const shown = JSON.parse(cli(box, box.root, 'show', String(box.item)).stdout);
  assert.ok(shown.thread.some(entry => entry.type === 'fact' && entry.text.includes('main-owned test/frozen.test.js (frozen case [G1])')), 'the gate names the main-owned file and case: ' + JSON.stringify(shown.thread));
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0, 'submit files no item');
  assert.ok(!shown.thread.some(entry => entry.type === 'fact' && entry.text.includes('unowned known main red')), 'no builder fact is written for a main-owned red');
  const shouts = rows(box, 'SELECT * FROM shout');
  const asked = shouts.filter(row => row.shout_to === 'coordinator' && row.shout_decision === 1 && String(row.shout_text).includes('test/frozen.test.js'));
  assert.equal(asked.length, 1, 'exactly one decision shout reaches the coordinator: ' + JSON.stringify(shouts));
});

test('an open Main red repair is linked, not duplicated [V4,B3]', async t => {
  const box = fixture(t);
  const repair = fileMainRed(box);
  const report = await settledSubmit(t, box, { submitted: true });
  assert.equal(report.submission?.gateGreen, true, JSON.stringify(report.gate));
  assert.deepEqual(report.submission.submissionProof.knownMainFailures.failures.map(row => row.item), [repair]);
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 1);
});
