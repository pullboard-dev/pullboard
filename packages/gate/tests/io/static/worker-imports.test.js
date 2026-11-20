/** @pullboard-world-pin runs the shipped worker-imports check from this tools copy against fixture trees. */
/** The static stage refuses new runner-worker reach outside its reviewed list and leaves reach inside it alone [C7,#8461]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const importsCheck = STATIC_TREE_CHECKS.find(check => check.name === 'worker-imports');

/**
 * Write a minimal tree whose worker closure holds the given files and whose reviewed list names the given units.
 *
 * @param {string} prefix - Fixture folder prefix.
 * @param {string[]} files - Files the fixture worker's closure holds.
 * @param {string[]} units - Units the reviewed list names.
 */
function writeTree(prefix, files, units) {
  const tree = privateFixtureFiles(prefix);
  tree.write('packages/runners/index.js', `export const runnerPackage = () => ({ files: ${JSON.stringify(Object.fromEntries(files.map(file => [file, ''])))} });\n`);
  tree.write('package.json', '{}\n');
  tree.write('packages/gate/data/baselines/worker-imports.json', JSON.stringify({ units }) + '\n');
  return tree;
}

test('gate.io-static-worker-imports.case-8461-clause-1-the-worker-imports: #8461 clause 1: the worker-imports check refuses a worker that reaches a package outside its reviewed list [C7]', t => {
  const tree = writeTree('pb-worker-imports-out-', ['packages/kernel/a.js', 'packages/search/b.js'], ['packages/kernel']);
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  const rows = importsCheck.run(tree.root);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /^packages\/gate\/data\/baselines\/worker-imports\.json:1: the runner worker now reaches packages\/search, outside its reviewed list/u);
});

test('gate.io-static-worker-imports.case-8461-clause-2-the-worker-imports: #8461 clause 2: the worker-imports check gives no finding for a worker that stays inside its reviewed list [C7]', t => {
  const tree = writeTree('pb-worker-imports-in-', ['packages/kernel/a.js', 'packages/kernel/b.js', 'apps/runner/w.js'], ['packages/kernel', 'apps/runner', 'packages/queue']);
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  assert.deepEqual(importsCheck.run(tree.root), []);
});
