/** The row-manifest merge names the test tiers file and no restructure plan index [C7,D3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeManifestRows } from '../../index.js';
import { rowManifest } from '../../index.js';

const TIERS = 'packages/gate/data/tests/tiers.json';
const PLAN_INDEX = 'packages/codemap/data/plan/cells.json';

test('merge.logic-manifest.no-plan-entry: clause 1: the row manifests include no restructure plan index entry and still merge the test tiers file by row [C7,D3]', () => {
  assert.equal(rowManifest(PLAN_INDEX), false, 'the plan index is no row manifest');
  assert.equal(mergeManifestRows(PLAN_INDEX, '{}', '{}', '{}'), null, 'a plan index conflict is not merged by row');
  assert.equal(rowManifest(TIERS), true, 'the test tiers file is still a row manifest');
  const row = file => ({ file });
  const doc = files => JSON.stringify({ version: 1, files });
  const merged = mergeManifestRows(TIERS, doc([row('a')]), doc([row('a'), row('b')]), doc([row('a'), row('c')]));
  assert.deepEqual(JSON.parse(merged.source).files, [row('a'), row('b'), row('c')], 'two added rows compose');
});
