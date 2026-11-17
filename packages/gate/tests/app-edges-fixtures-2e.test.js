/** The gate lease fixture takes openBoard, settledGateJob and executionServicesSource from its caller, so no app edge remains; second half of #6462 is #9605 [C7,CD12]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellsEdgeReport } from '../src/io/edges.js';

const REPO = join(import.meta.dirname, '../../..');
const FILES = ['packages/gate/tests/fixtures/resources/lease.js'];

test('clause 1: cellsEdgeReport(repo).packageApps has no row for the lease fixture [C7,CD12]', () => {
  const live = cellsEdgeReport(REPO, { files: FILES }).packageApps;
  for (const file of FILES) assert.equal(live[file], undefined, `${file} still reaches an app: ${JSON.stringify(live[file])}`);
});

test('clause 2: the committed cells-edges.json ceiling packageApps has no row for the lease fixture [C7,CD12]', () => {
  const ceiling = JSON.parse(readFileSync(join(REPO, 'packages/gate/data/ceilings/cells-edges.json'), 'utf8')).packageApps;
  for (const file of FILES) assert.equal(ceiling[file], undefined, `${file} still has a ceiling row`);
});
