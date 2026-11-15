/** The gate fixtures named by #6461 no longer reach apps/*: the live report and the committed ceiling both have no row for them [C7,CD12]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellsEdgeReport } from '../src/io/edges.js';

const REPO = join(import.meta.dirname, '../../..');
const FILES = [
  'packages/gate/tests/fixtures/clone.js',
  'packages/gate/tests/fixtures/cockpit/probe.mjs',
  'packages/gate/tests/fixtures/diagnostics.js',
  'packages/gate/tests/fixtures/functions.js',
  'packages/gate/tests/fixtures/p95.js',
  'packages/gate/tests/fixtures/watchdog/legacy.js',
  'packages/gate/tests/fixtures/pipeline/board/write.js',
  'packages/gate/tests/fixtures/pipeline/kit.js',
];

test('clause 1: cellsEdgeReport(repo).packageApps has no row for the listed files [C7]', () => {
  const live = cellsEdgeReport(REPO, { files: FILES }).packageApps;
  for (const file of FILES) assert.equal(live[file], undefined, `${file} still reaches an app: ${JSON.stringify(live[file])}`);
});

test('clause 2: the committed cells-edges.json ceiling packageApps has no row for those files [C7]', () => {
  const ceiling = JSON.parse(readFileSync(join(REPO, 'packages/gate/data/ceilings/cells-edges.json'), 'utf8')).packageApps;
  for (const file of FILES) assert.equal(ceiling[file], undefined, `${file} still has a ceiling row`);
});
