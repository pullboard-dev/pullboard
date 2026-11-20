/** The row-manifest merge names the plan index and the test tiers file, each merged by row [C7,D3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeManifestRows } from '../../index.js';
import { rowManifest } from '../../index.js';

const TIERS = 'packages/gate/data/tests/tiers.json';
const PLAN_INDEX = 'packages/codemap/data/plan/cells.json';

test('merge.logic-manifest.plan-index-by-row: clause 1: the plan index is a row manifest keyed by cell name, two added cell rows compose, a same-row edit refuses and the tiers file still merges by row [C7,D3]', () => {
  assert.equal(rowManifest(PLAN_INDEX), true, 'the plan index is a row manifest');
  const cell = (name, order, extra = {}) => ({ order, name, ...extra });
  const index = cells => JSON.stringify({ version: 1, cells });
  const base = [cell('kernel', 1)];
  const merged = mergeManifestRows(PLAN_INDEX, index(base), index([...base, cell('zeta', 3)]), index([...base, cell('alpha', 2)]));
  assert.deepEqual(JSON.parse(merged.source).cells.map(row => row.name), ['kernel', 'alpha', 'zeta'], 'two added rows compose in order');
  const edit = value => index([cell('kernel', 1, { allowedEdges: value })]);
  const refused = mergeManifestRows(PLAN_INDEX, index(base), edit(['a']), edit(['b']));
  assert.deepEqual(refused?.conflicts, ['cells:kernel'], 'a same-row edit refuses and names the row');
  assert.equal(rowManifest(TIERS), true, 'the test tiers file is still a row manifest');
  const row = file => ({ file });
  const doc = files => JSON.stringify({ version: 1, files });
  const tiers = mergeManifestRows(TIERS, doc([row('a')]), doc([row('a'), row('b')]), doc([row('a'), row('c')]));
  assert.deepEqual(JSON.parse(tiers.source).files, [row('a'), row('b'), row('c')], 'two added rows compose');
});
