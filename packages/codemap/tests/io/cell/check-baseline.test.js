/** @pullboard-test-input packages/codemap/src/io/cell/scripts/lints.js packages/codemap/src/io/main/lints.js packages/codemap/data/baselines/lints/index.json */
/** cell-lints --check holds main to the committed baseline, so a landing never becomes the new allowance [C7,CD23]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { importsIn } from '../../../../gate/index.js';
import { commonJsIn } from '../../../../gate/index.js';
import { fixtureCommittedGraph } from '../../../../../apps/cli/tests/fixtures/testkit.js';
import { runFixtureChild } from '../../../../gate/tests/fixtures/child.js';
import { cellLintReport } from '../../../index.js';
import { cellLintBaseline } from '../../../index.js';
import { planCellLintBaseline } from '../../../index.js';
import { writeCellLintBaseline } from '../../../index.js';

const BIN = fileURLToPath(new URL('../../../src/io/cell/scripts/lints.js', import.meta.url));

test('--check exits 1 and names the cycle edge when main holds a cycle its committed baseline never allowed [C7,CD23]', t => {
  const { root, put, commit } = fixtureCommittedGraph('pullboard-check-baseline-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = mode => runFixtureChild(process.execPath, [BIN, mode, root], { encoding: 'utf8' });
  put('package.json', JSON.stringify({ type: 'module', imports: { '#*': './packages/*/index.js', '#*.js': './packages/*.js' } }));
  put('apps/demo/index.js', "import { value } from '#sample'; console.log(value);\n");
  put('packages/sample/index.js', 'export const value = 1;\n');
  put('packages/codemap/data/plan/path-map/sample.json', JSON.stringify({ 'src/previous.js': 'packages/sample/index.js' }));
  commit();
  const clean = planCellLintBaseline(cellLintReport(root, { importsIn, commonJsIn })).baseline;
  writeCellLintBaseline(root, clean, { initialize: true, verify: () => JSON.stringify(cellLintBaseline(cellLintReport(root, { importsIn, commonJsIn }))) === JSON.stringify(clean) });
  commit();
  assert.equal(run('--check').status, 0, 'a clean main passes');
  // A landing that skipped the check adds a cycle and leaves the committed baseline alone.
  put('packages/sample/index.js', "import '#other'; export const value = 1;\n");
  put('packages/other/index.js', "import '#sample';\n");
  commit();
  const checked = run('--check');
  assert.equal(checked.status, 1, checked.stderr);
  assert.match(checked.stderr, /cycles:/u);
  assert.match(checked.stderr, /sample/u);
});
