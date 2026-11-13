/** Native flake landing: with reruns off a red landing runs nothing further [C7,H16]. */
import {
  targetRuns,
  assertReceipts,
} from '../../../../packages/git/tests/fixtures/flakes.js';
import { cliLocal } from '../../tests/fixtures/flakes/landing.js';
import { readyLanding } from '../../tests/fixtures/flakes/landing.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('landing with reruns off keeps its original red and runs nothing further [C7,H16]', async t => {
  const box = await readyLanding(t, false);
  const result = await cliLocal(box, box.root, 'land');
  assert.equal(result.code, 1, JSON.stringify(result.document)); // a batch whose every candidate is a culprit exits 1 (#4265)
  // Changed today with the landing rerun change: a red landing with reruns off stays blocked, files no legacy defect and runs the target once.
  assert.equal(result.document.batch.state, 'blocked');
  assert.deepEqual(result.document.landed, []);
  assert.equal(result.document.flakes.length, 0, 'no first-sighting legacy defect is filed');
  assert.equal(targetRuns(box), 2, 'the original run plus the base-main comparison (#3073) execute, with no new paired rerun');
  const report = (await cliLocal(box, box.root, 'flakes')).document;
  assert.equal(report.flakes.length, 0, 'a whole-file diagnosis is not relabeled as exact-target confirmation');
  assert.equal(report.unclassified.length, 1, 'the new ledger still retains the original red');
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assertReceipts(box, report.unclassified[0].observations[0]);
  assert.equal(box.git('rev-parse', 'HEAD').trim(), box.base);
  assert.equal(box.git('--git-dir=' + box.remote, 'rev-parse', 'main').trim(), box.base);
});
