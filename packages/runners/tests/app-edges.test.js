/** @pullboard-test-input source-cell packages/runners */
/** The runners fixtures named by #6458 no longer reach apps/*: the live report and the committed ceiling both have no row for them [C7,CD12]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellsEdgeReport } from '../../gate/src/io/edges.js';
import { cellsEdgesCeiling } from '../../gate/src/io/edges.js';

const REPO = join(import.meta.dirname, '../../..');
const FILES = [
  'packages/runners/tests/fixtures/advance.js',
  'packages/runners/tests/fixtures/fleet.js',
];

test('runners.app-edges.live-report-no-row: clause 1: cellsEdgeReport(repo).packageApps has no row for packages/runners/tests/fixtures/advance.js or packages/runners/tests/fixtures/fleet.js [C7]', () => {
  const live = cellsEdgeReport(REPO, { files: FILES }).packageApps;
  for (const file of FILES) assert.equal(live[file], undefined, `${file} still reaches an app: ${JSON.stringify(live[file])}`);
});

test('runners.app-edges.committed-ceiling-no-row: clause 2: the committed cells-edges.json packageApps ceiling has no row for those two files [C7]', () => {
  const ceiling = cellsEdgesCeiling().packageApps;
  for (const file of FILES) assert.equal(ceiling[file], undefined, `${file} still has a ceiling row`);
});
