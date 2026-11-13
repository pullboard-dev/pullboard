/** Real affected-case known-main submission controls at the pulled gate [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { cli } from '../../../../tests/fixtures/affected.js';
import { rows } from '../../../../tests/fixtures/affected.js';
import { fileMainRed } from '../../../../tests/fixtures/affected.js';
import { settledSubmit } from '../../../../tests/fixtures/affected.js';

test('an affected case red identically on main with no owner records a green gate naming it, shouts, and files nothing [V4,B3,C7]', async t => {
  const box = fixture(t);
  const report = await settledSubmit(t, box);
  // Since #3534 the gate records green over main's own reds and names them, instead of a builder fact.
  assert.equal(report.submission?.gateGreen, true, 'a red only in main\'s own case records green: ' + JSON.stringify(report.gate));
  assert.equal(rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red:%'").length, 0, 'submit files no item');
  const shown = JSON.parse(cli(box, box.root, 'show', String(box.item)).stdout);
  assert.ok(shown.thread.some(entry => entry.type === 'fact' && entry.text.includes('main-owned test/affected.test.js (affected case [G1])')), 'the gate names the main-owned file and case: ' + JSON.stringify(shown.thread));
  const asked = rows(box, 'SELECT * FROM shout').filter(row => row.shout_to === 'coordinator' && row.shout_decision === 1 && String(row.shout_text).includes('test/affected.test.js'));
  assert.equal(asked.length, 1, 'exactly one decision shout reaches the coordinator');
});

test('an open Main red repair naming the affected file is linked [V4,B3,C7]', async t => {
  const box = fixture(t);
  const repair = fileMainRed(box);
  const report = await settledSubmit(t, box);
  assert.equal(report.submission?.gateGreen, true, JSON.stringify(report.gate));
  assert.deepEqual(report.submission.submissionProof.knownMainFailures.failures.map(row => [row.file, row.item]), [['test/affected.test.js', repair]]);
});
