/** The gate pipeline orphan-worker harness named by #9607 (a slice of #6462), moved to apps/runner no longer reach apps/*: the live report and the committed ceiling both have no row for them [C7,CD12]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellsEdgeReport } from '../src/io/edges.js';
import { APP_HARNESSES } from '../src/io/matrix.js';

const REPO = join(import.meta.dirname, '../../..');
const FILES = [
  'packages/gate/tests/fixtures/pipeline/worker.js',
];

test('gate.app-edges-fixtures-2g.cellsedgereport-repo-packageapps-has-row: clause 1: cellsEdgeReport(repo).packageApps has no row for pipeline/worker.js [C7]', () => {
  const moved = APP_HARNESSES['orphan-worker'];
  const live = cellsEdgeReport(REPO, { files: [moved] }).packageApps;
  for (const file of FILES) assert.equal(existsSync(join(REPO, file)), false, `${file} still exists in the gate package`);
  for (const file of [...FILES, moved]) assert.equal(live[file], undefined, `${file} still reaches an app: ${JSON.stringify(live[file])}`);
});

test('gate.app-edges-fixtures-2g.committed-cells-edges-json-ceiling: clause 2: the committed cells-edges.json ceiling packageApps has no row for pipeline/worker.js [C7]', () => {
  const ceiling = JSON.parse(readFileSync(join(REPO, 'packages/gate/data/ceilings/cells-edges.json'), 'utf8')).packageApps;
  for (const file of FILES) assert.equal(ceiling[file], undefined, `${file} still has a ceiling row`);
});

test('gate.app-edges-fixtures-2g.pipeline-hop-matrix-still-names: clause 3: the pipeline hop matrix still names the moved harness for hop orphan-worker [C7]', () => {
  assert.equal(APP_HARNESSES['orphan-worker'], 'apps/runner/tests/io/pipeline/worker.test.js');
  assert.ok(existsSync(join(REPO, APP_HARNESSES['orphan-worker'])), 'the moved harness exists');
});
