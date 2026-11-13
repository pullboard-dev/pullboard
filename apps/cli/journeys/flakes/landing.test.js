/** Native flake landing: a red landing keeps its original verdict [C7,H16]. */
import {
  targetRuns,
  assertReceipts,
} from '../../../../packages/git/tests/fixtures/flakes.js';
import { cliLocal } from '../../tests/fixtures/flakes/landing.js';
import { readyLanding } from '../../tests/fixtures/flakes/landing.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('enabled landing retains its original red without a second diagnostic or first legacy defect [C7,H16]', async t => {
  const box = await readyLanding(t, true);
  const result = await cliLocal(box, box.root, 'land');
  assert.equal(result.code, 1, JSON.stringify(result.document)); // a batch whose every candidate is a culprit exits 1 (#4265)
  assert.equal(result.document.batch.state, 'blocked');
  assert.deepEqual(result.document.landed, []);
  assert.deepEqual(result.document.flakes, [], 'typed observations do not file a first-sighting legacy landing_flake');
  assert.equal(result.document.batch.gateResults[0].isGreen, false, 'the diagnostic pass never replaces the original red');
  // The landing also compares its red file with base main (#3073), which executes the target once more in a main checkout.
  assert.equal(targetRuns(box), 4, 'one original, one exact-target pair, one independently pinned main control, one base-main comparison; no legacy whole-file remeasurement');
  const report = (await cliLocal(box, box.root, 'flakes')).document;
  assert.equal(report.flakes.length, 1);
  assert.equal(report.flakes[0].count, 1);
  // Changed with #3131: a proven ledger flake files its repair on the first sighting.
  assert.ok(Number.isSafeInteger(report.flakes[0].item), 'a proven flake files one repair item on its first sighting');
  assert.equal(report.flakes[0].observations[0].kind, 'land');
  assertReceipts(box, report.flakes[0].observations[0]);
  assert.equal(box.git('rev-parse', 'HEAD').trim(), box.base);
  assert.equal(box.git('--git-dir=' + box.remote, 'rev-parse', 'main').trim(), box.base, 'the private destination received no landing');
  const refused = await cliLocal(box, box.root, 'land', '--adopt');
  assert.equal(refused.document.error?.code, 'LAND_ADOPT', 'a terminal blocked batch is not an interrupted landing');
  assert.equal(targetRuns(box), 4, 'a refused adoption adds no measurement');
  assert.equal((await cliLocal(box, box.root, 'flakes')).document.flakes[0].count, 1);
});
