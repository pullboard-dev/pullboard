/** @pullboard-world-pin runs the shipped layout class from this tools copy against fixture trees in real git repos. */
/** The layout ratchet is a static check class: pre-commit, submit and landing all refuse a rising rule count [C7,#5420]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { STATIC_CHECKS } from '../../../src/io/static/check/registry.js';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';
import { layoutProblems } from '../../../src/io/static/layout.js';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../fixtures/child.js';

const BASELINE = 'packages/codemap/data/baselines/layout.json';
const OFFENDER = 'packages/demo/data/stray.json';
const RULES = ['data-group'];

/**
 * A git fixture whose baseline allows zero `data-group` findings and whose tools copy baseline is not consulted.
 *
 * @param {import('node:test').TestContext} t
 * @returns {{ root: string, tree: { write: Function } }}
 */
function fixture(t) {
  const tree = privateFixtureFiles('pb-layout-');
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  runFixtureGit(['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: tree.root });
  tree.write(BASELINE, `${JSON.stringify({ version: 1, rules: Object.fromEntries(RULES.map(rule => [rule, 0])) })}\n`);
  return { root: tree.root, tree };
}

/** Stage everything in a fixture repository. */
const addAll = root => runFixtureGit(['add', '-A'], { cwd: root });

test('clause 1: a tracked file that raises a layout rule count is a path:line finding naming the rule and the next step, and none once removed [C7,#5420]', t => {
  const { root, tree } = fixture(t);
  tree.write(OFFENDER, '{}\n');
  addAll(root);
  const rows = layoutProblems(root);
  assert.equal(rows.length, 1);
  assert.match(rows[0], new RegExp(`^${BASELINE.replace(/\./gu, '\\.')}:1: .*data-group.*rose from 0 to 1`, 'u'));
  assert.match(rows[0], /next: move the offending files/u);
  runFixtureGit(['rm', '-q', '-f', '--cached', OFFENDER], { cwd: root });
  assert.deepEqual(layoutProblems(root), []);
});

test('clause 1: the class is registered for both pre-commit and submit and landing, and both report the same finding [C7,#5420]', t => {
  const { root, tree } = fixture(t);
  tree.write(OFFENDER, '{}\n');
  addAll(root);
  const tree_ = STATIC_TREE_CHECKS.find(check => check.name === 'layout');
  const staged = STATIC_CHECKS.find(check => check.name === 'layout');
  assert.ok(tree_ && staged, 'layout is registered in STATIC_TREE_CHECKS and STATIC_CHECKS');
  const expected = layoutProblems(root);
  assert.equal(expected.length, 1);
  assert.deepEqual(tree_.run(root), expected);
  assert.deepEqual(staged.run({ root, files: [] }), expected, 'pre-commit judges the whole tree whatever files it was given');
});

test('clause 2: the class judges the checked tree\'s own baseline file, not the tools copy\'s, and runs in under 2 s on this repository [C7,#5420]', t => {
  const { root, tree } = fixture(t);
  tree.write(OFFENDER, '{}\n');
  addAll(root);
  assert.equal(layoutProblems(root).length, 1, 'a zero baseline in the tree refuses');
  tree.write(BASELINE, `${JSON.stringify({ version: 1, rules: { 'data-group': 1 } })}\n`);
  assert.deepEqual(layoutProblems(root), [], 'a baseline of one in the tree accepts, though the tools copy holds its own numbers');
  const repo = new URL('../../../../../', import.meta.url).pathname;
  const started = Date.now();
  assert.deepEqual(layoutProblems(repo), [], 'this repository is within its baseline');
  assert.ok(Date.now() - started < 2000, `ran in ${Date.now() - started} ms`); // budget: declared by clause 2 of #5420 as under 2 s
});

test('a plain project with no layout baseline, holding .claude, web and .mcp.json at its root, has no layout finding [C7,#6544]', t => {
  const tree = privateFixtureFiles('pb-layout-plain-');
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  runFixtureGit(['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: tree.root });
  for (const file of ['.claude/settings.json', '.codex/config.toml', '.mcp.json', 'web/index.html']) tree.write(file, '{}\n');
  addAll(tree.root);
  assert.deepEqual(layoutProblems(tree.root), []);
  tree.write('web/app.test.js', "import { test } from 'node:test';\n");
  const waits = STATIC_CHECKS.find(check => check.name === 'test-waits');
  assert.deepEqual(waits.run({ root: tree.root, files: ['web/app.test.js'], read: () => ({ source: "import { test } from 'node:test';\n" }) }), [], 'test-waits has no baseline to judge');
});

test('.pullboard is an allowed root entry in a tree that keeps a layout baseline [C7,#6544]', t => {
  const { root, tree } = fixture(t);
  tree.write(BASELINE, `${JSON.stringify({ version: 1, rules: { 'root-entry': 0 } })}\n`);
  tree.write('.pullboard/test-file-budgets/audit.json', '{}\n');
  addAll(root);
  assert.deepEqual(layoutProblems(root), []);
});
