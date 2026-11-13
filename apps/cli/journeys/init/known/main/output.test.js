/** Exact case guidance carries the real main receipt in structured test output, without changing verdicts [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mainFailureNotices } from '../../../../../../packages/landing/index.js';
import {
  cli,
  fixture,
} from '../../../../tests/fixtures/affected.js';
import {
  FILE,
  notice,
} from '../../../../tests/fixtures/init/known-main-notice.js';

test('identical main case is structured in test with a real receipt, and incomplete evidence is refused [V4,B3,C7]', async t => {
  const box = fixture(t);
  const tested = cli(box, box.builder, 'test', FILE, '--compare-main');
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  const report = JSON.parse(tested.stdout);
  assert.equal(report.green, false, 'guidance does not turn a red test green');
  assert.equal(report.mainFailures.length, 1, JSON.stringify(report));
  notice(report.mainFailures[0], box);

  const comparison = { main: box.main, files: report.known };
  const failures = report.known[0].failures;
  assert.equal(mainFailureNotices(box.builder, failures, comparison).length, 1);
  for (const bad of [
    { ...comparison, unavailable: 'runner unavailable' },
    { ...comparison, main: box.head },
    { ...comparison, files: report.known.map(({ receiptId, ...entry }) => entry) },
    { ...comparison, files: report.known.map(entry => ({ ...entry, receiptId: '00000000-0000-0000-0000-000000000000' })) },
    { ...comparison, files: report.known.map(entry => ({ ...entry, failures: undefined })) },
    { ...comparison, files: [...report.known, ...report.known] },
  ]) assert.deepEqual(mainFailureNotices(box.builder, failures, bad), [], 'incomplete, stale or ambiguous evidence is not accepted wording');
});
