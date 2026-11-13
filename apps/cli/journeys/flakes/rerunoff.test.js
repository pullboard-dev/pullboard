/** Native flake landing: with reruns off a red landing runs nothing further [C7,H16]. */
import {
  targetRuns,
  assertReceipts,
} from '../../../../packages/git/tests/fixtures/flakes.js';
import { cliLocal } from '../../tests/fixtures/flakes/landing.js';
import { readyLanding } from '../../tests/fixtures/flakes/landing.js';
import { settleLand } from '../../tests/fixtures/flakes/landing.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('landing with reruns off keeps its original red and runs nothing further [C7,H16]', async t => {
  const box = await readyLanding(t, false);
  const result = await cliLocal(box, box.root, 'land');
  assert.equal(result.code, 0, JSON.stringify(result.document));
  // A red landing with reruns off returns the item, files no legacy defect and runs the target once; pull runs no base-main comparison (#3073).
  const settled = await settleLand(box);
  assert.equal(settled.item_merged_commit ?? null, null);
  assert.equal(targetRuns(box), 1, 'only the original run executes, with no paired rerun ' + JSON.stringify(Object.keys(settled)) + JSON.stringify(settled.thread ?? settled.events ?? settled.facts ?? null).slice(0, 6000) + box.readData(box.counter, 'utf8'));
  const report = (await cliLocal(box, box.root, 'flakes')).document;
  assert.equal(report.flakes.length, 0, 'a whole-file diagnosis is not relabeled as exact-target confirmation');
  assert.equal(report.unclassified.length, 1, 'the new ledger still retains the original red');
  assert.equal(report.unclassified[0].observations[0].paired, null);
  assertReceipts(box, report.unclassified[0].observations[0]);
  assert.equal(box.git('rev-parse', 'HEAD').trim(), box.base);
  assert.equal(box.git('--git-dir=' + box.remote, 'rev-parse', 'main').trim(), box.base);
});
