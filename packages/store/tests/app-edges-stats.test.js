/** @pullboard-test-input source-cell gate */
/** The store stats fixtures open boards and run git through package homes, so they no longer reach apps/* (slice of #6457) [C7]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellsEdgeReport } from '../../gate/src/io/edges.js';

const REPO = join(import.meta.dirname, '../../..');
const FILES = ['packages/board/tests/fixtures/stats/compare.js', 'packages/board/tests/fixtures/stats/time.js'];

test('store.app-edges-stats.cellsedgereport-repo-packageapps-has-no-row: clause 1: cellsEdgeReport(repo).packageApps has no row for stats/compare.js or stats/time.js [C7]', () => {
  const live = cellsEdgeReport(REPO, { files: FILES }).packageApps;
  for (const file of FILES) assert.equal(live[file], undefined, `${file} still reaches an app: ${JSON.stringify(live[file])}`);
});

test('store.app-edges-stats.the-committed-cells-edges-json-ceiling: clause 2: the committed cells-edges.json ceiling packageApps has no row for those two files [C7]', () => {
  const ceiling = JSON.parse(readFileSync(join(REPO, 'packages/gate/data/ceilings/cells-edges.json'), 'utf8')).packageApps;
  for (const file of FILES) assert.equal(ceiling[file], undefined, `${file} still has a ceiling row`);
});

test('store.app-edges-stats.the-old-stats-fixture-directory-is-gone: clause 3: the old directory packages/store/tests/fixtures/stats no longer exists in the checkout [C7]', () => {
  assert.equal(readdirSync(join(REPO, 'packages/store/tests/fixtures')).includes('stats'), false, 'the old stats fixture directory is still present');
});
