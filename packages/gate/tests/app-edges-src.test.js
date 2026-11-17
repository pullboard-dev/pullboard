/** No source file under packages/ imports, spawns or reads a path under apps/; the only package-to-app rows left are test fixtures [C7,CD12]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellsEdgeReport } from '../src/io/edges.js';

const REPO = join(import.meta.dirname, '../../..');
const SRC = /^packages\/[^/]+\/src\//;

test('gate.app-edges-src.live-report-lists-packages-src: clause 1: the live report lists no packages/*/src file that reaches apps/ [C7]', () => {
  const live = cellsEdgeReport(REPO).packageApps;
  const bad = Object.keys(live).filter(file => SRC.test(file));
  assert.deepEqual(bad, [], `package source files reach an app: ${bad.join(', ')}`);
});

test('gate.app-edges-src.committed-cells-edges-json-ceiling: clause 1: the committed cells-edges.json ceiling holds no packageApps row for a packages/*/src file [C7]', () => {
  const ceiling = JSON.parse(readFileSync(join(REPO, 'packages/gate/data/ceilings/cells-edges.json'), 'utf8')).packageApps;
  const bad = Object.keys(ceiling).filter(file => SRC.test(file));
  assert.deepEqual(bad, [], `ceiling rows for package source files: ${bad.join(', ')}`);
});
