/** The cells edge scanner follows a re-export-only file to its real cell, so a shim cannot hide a deep import [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  after,
  test,
} from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { cellsEdgeReport } from '../../../src/io/edges.js';

const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A fixture tree with an empty plan and the given files. */
function fixture(files) {
  const inputs = privateFixtureFiles('cells-edges-shims-');
  made.push(inputs.root);
  const all = { 'packages/codemap/data/plan/cells.json': JSON.stringify({ cells: [] }), 'packages/b/src/real.js': 'export const real = 1;\n', ...files };
  for (const [file, text] of Object.entries(all)) inputs.write(file, text);
  return inputs.root;
}

test('clause 1: a file importing a shim in its own cell that forwards into cell b src is a deep import into b [C7]', () => {
  const root = fixture({
    'packages/a/src/shim.js': "export { real } from '../../b/src/real.js';\n",
    'packages/a/src/use.js': "import { real } from './shim.js';\nexport const x = real;\n",
  });
  const report = cellsEdgeReport(root);
  assert.deepEqual(report.files['packages/a/src/use.js'].edges.map(({ to, deep }) => ({ to, deep })), [{ to: 'b', deep: true }]);
  assert.equal(report.files['packages/a/src/use.js'].deep, 1);
});

test('clause 1: a shim that stays inside its own cell is not reported [C7]', () => {
  const root = fixture({
    'packages/a/src/inner.js': 'export const inner = 1;\n',
    'packages/a/src/shim.js': "export { inner } from './inner.js';\n",
    'packages/a/src/use.js': "import { inner } from './shim.js';\nexport const x = inner;\n",
  });
  assert.deepEqual(cellsEdgeReport(root).files['packages/a/src/use.js'], undefined);
});

test('clause 1: a forwarder that holds other code is not followed [C7]', () => {
  const root = fixture({
    'packages/a/src/mixed.js': "export { real } from '../../b/src/real.js';\nexport const own = 1;\n",
    'packages/a/src/use.js': "import { own } from './mixed.js';\nexport const x = own;\n",
  });
  assert.deepEqual(cellsEdgeReport(root).files['packages/a/src/use.js'], undefined);
});
