/** The gate resource capacity and release fixtures named by #9601 (a slice of #6462) no longer reach apps/*: the live report and the committed ceiling both have no row for them [C7,CD12]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellsEdgeReport } from '../src/io/edges.js';

const REPO = join(import.meta.dirname, '../../..');
const FILES = [
  'packages/gate/tests/fixtures/resources/capacity.js',
  'packages/gate/tests/fixtures/resources/release.js',
];

test('gate.app-edges-fixtures-2a.cellsedgereport-repo-packageapps-has-row: clause 1: cellsEdgeReport(repo).packageApps has no row for capacity.js or release.js [C7]', () => {
  const live = cellsEdgeReport(REPO, { files: FILES }).packageApps;
  for (const file of FILES) assert.equal(live[file], undefined, `${file} still reaches an app: ${JSON.stringify(live[file])}`);
});

test('gate.app-edges-fixtures-2a.committed-cells-edges-json-ceiling: clause 2: the committed cells-edges.json ceiling packageApps has no row for those two files [C7]', () => {
  const ceiling = JSON.parse(readFileSync(join(REPO, 'packages/gate/data/ceilings/cells-edges.json'), 'utf8')).packageApps;
  for (const file of FILES) assert.equal(ceiling[file], undefined, `${file} still has a ceiling row`);
});
