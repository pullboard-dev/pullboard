/** Package-to-app edges have their own ceiling that only falls: a new package edge into apps/* is refused by cells-edges [CD12]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  cellsEdgeProblems,
  cellsEdgeReport,
  ceilingsOf,
} from '../../../src/io/edges.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const REPO = join(import.meta.dirname, '../../../../..');
const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A fixture tree of the given files, with an empty cells plan. */
function fixture(files) {
  const inputs = privateFixtureFiles('package-app-');
  made.push(inputs.root);
  const all = { 'packages/codemap/data/plan/cells.json': JSON.stringify({ cells: [] }), ...files };
  for (const [file, text] of Object.entries(all)) inputs.write(file, text);
  return inputs.root;
}

const BASE = {
  'packages/a/index.js': "import { b } from '../b/index.js';\nimport { c } from '../c/index.js';\nexport const a = b + c;\n",
  'packages/b/index.js': 'export const b = 1;\n',
  'packages/c/index.js': 'export const c = 2;\n',
  'apps/cli/run.js': 'export const run = 1;\n',
  'apps/view/page.js': 'export const page = 1;\n',
};

test('gate.io-edges-package-app.a-new-package-spawn-read-or: clause 1: a new package spawn, read or import of apps/* is refused while the file and cell edge totals stay under their ceilings [C7]', () => {
  const root = fixture(BASE);
  const ceilings = ceilingsOf(cellsEdgeReport(root));
  assert.deepEqual(ceilings.packageApps, {});
  ceilings.files['packages/a/index.js'] = { cells: 3, deep: 0 };
  ceilings.cells.a = { imports: ['apps/cli', 'apps/view', 'b', 'c'], deepImporters: 0 };
  const reaches = {
    'spawn path': "import { spawn } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\nexport const go = () => spawn(process.execPath, [fileURLToPath(new URL('../../apps/cli/run.js', import.meta.url))]);\n",
    'read path': "import { readFileSync } from 'node:fs';\nexport const text = () => readFileSync('apps/view/page.js', 'utf8');\n",
    'static import': "import { run } from '../../apps/cli/run.js';\nexport const go = run;\n",
    'dynamic import': "export const go = () => import('../../apps/cli/run.js');\n",
  };
  for (const [kind, source] of Object.entries(reaches)) {
    const file = 'packages/a/index.js';
    writeFileSync(join(root, file), `${BASE[file]}${source}`);
    const problems = cellsEdgeProblems(root, { files: [file], ceilings });
    assert.ok(problems.length, `${kind}: refused`);
    assert.ok(problems.every(row => row.path === file && /reaches apps\/(?:cli|view) .*CD12/u.test(row.text)), `${kind}: ${JSON.stringify(problems)}`);
    const allowed = { ...ceilings, packageApps: ceilingsOf(cellsEdgeReport(root, { files: [file] })).packageApps };
    assert.deepEqual(cellsEdgeProblems(root, { files: [file], ceilings: allowed }), [], `${kind}: a committed row lets today's edge stand`);
  }
});

test('gate.io-edges-package-app.the-gate-run-shell-names-no: clause 1: the gate run shell names no apps/ path and carries no package app row [C7]', () => {
  const ceiling = JSON.parse(readFileSync(join(REPO, 'packages/gate/data/ceilings/cells-edges.json'), 'utf8')).packageApps;
  const file = 'packages/gate/src/io/run/shell.js';
  assert.equal(ceiling[file], undefined);
  assert.ok(Object.keys(ceiling).every(row => row.startsWith('packages/')));
  assert.doesNotMatch(readFileSync(join(REPO, file), 'utf8'), /apps\//u);
  assert.deepEqual(cellsEdgeReport(REPO, { files: [file] }).packageApps[file] ?? [], []);
});
