/** Native flake landing: a red landing keeps its original verdict [C7,H16]. */
import {
  targetRuns,
  assertReceipts,
} from '../../../../packages/git/tests/fixtures/flakes.js';
import { cliLocal } from '../../tests/fixtures/flakes/landing.js';
import { readyLanding } from '../../tests/fixtures/flakes/landing.js';
import { settleLand } from '../../tests/fixtures/flakes/landing.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('enabled landing retains its original red without a second diagnostic or first legacy defect [C7,H16]', async t => {
  const box = await readyLanding(t, true);
  const result = await cliLocal(box, box.root, 'land');
  assert.equal(result.code, 0, JSON.stringify(result.document));
  // The land job is pulled: its receipt returns the red item to its builder and lands nothing.
  const settled = await settleLand(box);
  assert.equal(settled.item_merged_commit ?? null, null);
  assert.deepEqual((await cliLocal(box, box.root, 'flakes')).document.legacy ?? [], [], 'typed observations do not file a first-sighting legacy landing_flake');
  // The runner pairs the red once at the merged tree and once at pinned main; pull runs no base-main comparison (#3073).
  assert.equal(targetRuns(box), 3, 'one original, one exact-target pair, one independently pinned main control; no legacy whole-file remeasurement');
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
  assert.notEqual(refused.code, 0, 'a settled red landing is not an interrupted landing');
  assert.equal(targetRuns(box), 3, 'a refused adoption adds no measurement');
  assert.equal((await cliLocal(box, box.root, 'flakes')).document.flakes[0].count, 1);
});
