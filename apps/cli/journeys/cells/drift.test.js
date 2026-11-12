/** The gate's static stage refuses each kind of cell drift by its own name, on a tree with no plan file [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { cellLintGrowth } from '../../../../packages/codemap/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { cellsEdgeProblems } from '../../../../packages/gate/src/io/edges.js';
import { cellsEdgeReport } from '../../../../packages/gate/src/io/edges.js';
import { ceilingsOf } from '../../../../packages/gate/src/io/edges.js';

/** A clean two-package tree that meets every kept rule and has no plan file, committed in a private Git repo. */
function cleanTree(t) {
  const { root, put } = fixture(t);
  // The shared fixture ships a plan seed and a legacy src tree; this tree starts from nothing so no plan file can be read.
  git(root, 'rm', '-rqf', '.');
  put('package.json', JSON.stringify({ type: 'module', imports: { '#*': './packages/*/index.js' } }));
  put('packages/alpha/src/logic/a.js', 'export const a = 1;\n');
  put('packages/alpha/index.js', "export { a } from './src/logic/a.js';\n");
  put('packages/beta/src/logic/b.js', "import { a } from '#alpha';\nexport const b = a;\n");
  put('packages/beta/index.js', "export { b } from './src/logic/b.js';\n");
  put('apps/cli/index.js', "import '#beta';\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'clean cells');
  return { root, put, ceilings: null };
}

/** What the static stage would refuse: edge rows by their text and cell-lint growth by metric name. */
function refusals(box) {
  git(box.root, 'add', '-A');
  const edges = cellsEdgeProblems(box.root, { ceilings: box.ceilings }).map(row => row.text);
  const lint = cellLintGrowth(cellLintReport(box.root, { importsIn, commonJsIn }), box.baseline).map(row => row.metric);
  return { edges, lint };
}

/** A clean tree with its edge ceilings and lint baseline measured from itself, never from a plan. */
function accepted(t) {
  const box = cleanTree(t);
  box.ceilings = ceilingsOf(cellsEdgeReport(box.root));
  box.baseline = cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn }));
  return box;
}

test('clause 1: an undeclared new cross-cell import is refused as a new cross-cell import [C7]', t => {
  const box = accepted(t);
  box.put('packages/beta/src/logic/c.js', "import { a } from '../../../alpha/index.js';\nexport const c = a;\n");
  assert.match(refusals(box).edges.join('\n'), /new cross-cell import of alpha exceeds the ratchet/u);
});

test('clause 1: a deep import into another cell\'s src is refused as a deep import [C7]', t => {
  const box = accepted(t);
  box.put('packages/beta/src/logic/b.js', "import { a } from '../../../alpha/src/logic/a.js';\nexport const b = a;\n");
  assert.match(refusals(box).edges.join('\n'), /deep import into alpha's src exceeds the ratchet/u);
});

test('clause 1: an edge that closes a cycle is refused as cycles growth [CD23]', t => {
  const box = accepted(t);
  box.put('packages/alpha/src/logic/a.js', "import { b } from '#beta';\nexport const a = b;\n");
  assert.ok(refusals(box).lint.includes('cycles'));
});

test('clause 1: a new source file outside any cell and the root allowlist is refused as strays growth [CD61]', t => {
  const box = accepted(t);
  box.put('tools/helper.js', 'export {};\n');
  assert.ok(refusals(box).lint.includes('strays'));
});

test('clause 2: the clean tree passes every drift check with no plan file anywhere in it [C7]', t => {
  const box = accepted(t);
  assert.equal(existsSync(join(box.root, 'packages/codemap/data/plan')), false);
  const result = refusals(box);
  assert.deepEqual(result.edges, []);
  assert.deepEqual(result.lint, []);
});
