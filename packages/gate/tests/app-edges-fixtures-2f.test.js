/** The gate pipeline spec harness named by #9606 (a slice of #6462), moved to apps/runner no longer reach apps/*: the live report and the committed ceiling both have no row for them [C7,CD12]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellsEdgeReport } from '../src/io/edges.js';
import { APP_HARNESSES } from '../src/io/matrix.js';

const REPO = join(import.meta.dirname, '../../..');
const FILES = [
  'packages/gate/tests/fixtures/pipeline/spec.js',
];

test('gate.app-edges-fixtures-2f.cellsedgereport-repo-packageapps-has-row: clause 1: cellsEdgeReport(repo).packageApps has no row for pipeline/spec.js [C7]', () => {
  const moved = APP_HARNESSES['runner-spec'];
  const live = cellsEdgeReport(REPO, { files: [moved] }).packageApps;
  for (const file of FILES) assert.equal(existsSync(join(REPO, file)), false, `${file} still exists in the gate package`);
  for (const file of [...FILES, moved]) assert.equal(live[file], undefined, `${file} still reaches an app: ${JSON.stringify(live[file])}`);
});

test('gate.app-edges-fixtures-2f.committed-cells-edges-json-ceiling: clause 2: the committed cells-edges.json ceiling packageApps has no row for pipeline/spec.js [C7]', () => {
  const ceiling = JSON.parse(readFileSync(join(REPO, 'packages/gate/data/ceilings/cells-edges.json'), 'utf8')).packageApps;
  for (const file of FILES) assert.equal(ceiling[file], undefined, `${file} still has a ceiling row`);
});

test('gate.app-edges-fixtures-2f.pipeline-hop-matrix-still-names: clause 3: the pipeline hop matrix still names the moved harness for hop runner-spec [C7]', () => {
  assert.equal(APP_HARNESSES['runner-spec'], 'apps/runner/tests/io/pipeline/spec.test.js');
  assert.ok(existsSync(join(REPO, APP_HARNESSES['runner-spec'])), 'the moved harness exists');
});
