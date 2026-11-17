/** The packages named by #6456 no longer reach apps/*: the live report and the committed ceiling both have no row for them [C7,CD12]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellsEdgeReport } from '../../gate/src/io/edges.js';

const REPO = join(import.meta.dirname, '../../..');
const FILES = [
  'packages/state/tests/fixtures/api.js',
];

test('state.app-edges.clause-1-cellsedgereport-repo: clause 1: cellsEdgeReport(repo).packageApps has no row for the listed files [C7]', () => {
  const live = cellsEdgeReport(REPO, { files: FILES.filter(file => existsSync(join(REPO, file))) }).packageApps;
  for (const file of FILES) assert.equal(live[file], undefined, `${file} still reaches an app: ${JSON.stringify(live[file])}`);
});

test('state.app-edges.clause-2-the-committed-cells-edges-json: clause 2: the committed cells-edges.json ceiling packageApps has no row for those files [C7]', () => {
  const ceiling = JSON.parse(readFileSync(join(REPO, 'packages/gate/data/ceilings/cells-edges.json'), 'utf8')).packageApps;
  for (const file of FILES) assert.equal(ceiling[file], undefined, `${file} still has a ceiling row`);
});
