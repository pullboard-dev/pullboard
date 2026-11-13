/** An open Main red repair naming a red affected file is linked at the pulled gate [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../../tests/fixtures/affected.js';
import { fileMainRed } from '../../../../../tests/fixtures/affected.js';
import { settledSubmit } from '../../../../../tests/fixtures/affected.js';

test('an open Main red repair naming the affected file is linked [V4,B3,C7]', async t => {
  const box = fixture(t);
  const repair = fileMainRed(box);
  const report = await settledSubmit(t, box);
  assert.equal(report.submission?.gateGreen, true, JSON.stringify(report.gate));
  assert.deepEqual(report.submission.submissionProof.knownMainFailures.failures.map(row => [row.file, row.item]), [['test/affected.test.js', repair]]);
});
