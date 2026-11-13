/** Several open repairs naming one test file each own the case their criterion names, at the pulled gate [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { rows } from '../../../../tests/fixtures/affected.js';
import { SHARED } from '../../../../tests/fixtures/affected.js';
import { fileCaseRepair as fileMainRed } from '../../../../tests/fixtures/affected.js';
import { settledSubmit } from '../../../../tests/fixtures/affected.js';

test('two repairs naming the same file each own the case their criterion names [V4,B3,C7]', async t => {
  const box = fixture(t, { affected: SHARED });
  const alpha = fileMainRed(box, "The case 'alpha case' passes on main.");
  const beta = fileMainRed(box, "The case 'beta case [G1]' passes on main.");
  const report = await settledSubmit(t, box);
  assert.equal(report.submission?.gateGreen, true, JSON.stringify(report.gate));
  const owners = Object.fromEntries(report.submission.submissionProof.knownMainFailures.failures.map(row => [row.name, row.item]));
  assert.deepEqual(owners, { 'alpha case [G1]': alpha, 'beta case [G1]': beta });
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 1);
});

