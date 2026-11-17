/** @pullboard-test-input source-cell packages/flakes packages/gate */
/** The packages named by #6452 no longer reach apps/*: the live report and the committed ceiling both have no row for them [C7,CD12]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellsEdgeReport } from '../../gate/src/io/edges.js';
import { cellsEdgesCeiling } from '../../gate/src/io/edges.js';

const REPO = join(import.meta.dirname, '../../..');
const FILES = [
  'packages/flakes/src/io/native.js',
];

test('flakes.app-edges.live-report-no-row: clause 1: cellsEdgeReport(repo).packageApps has no row for the listed files [C7]', () => {
  const live = cellsEdgeReport(REPO, { files: FILES }).packageApps;
  for (const file of FILES) assert.equal(live[file], undefined, `${file} still reaches an app: ${JSON.stringify(live[file])}`);
});

test('flakes.app-edges.committed-ceiling-no-row: clause 2: the committed cells-edges.json ceiling packageApps has no row for those files [C7]', () => {
  const ceiling = cellsEdgesCeiling().packageApps;
  for (const file of FILES) assert.equal(ceiling[file], undefined, `${file} still has a ceiling row`);
});
