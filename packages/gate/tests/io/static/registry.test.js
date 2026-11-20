/** @pullboard-world-pin runs the shipped prose-commands check from this tools copy against fixture trees in real git repos. */
/** The prose-commands static check judges the catalog of the tree under test, not the gate's tools copy [C7,#3827]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { runShell } from '../../../heavy.js';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../fixtures/child.js';

/** The app paths the CLI static entry hands the registry, as that entry declares them. */
const STATIC_APPS = { cliCell: 'apps/cli', cliIndex: 'apps/cli/index.js', cliHelp: 'apps/cli/src/logic/help.js' };
const proseCheck = STATIC_TREE_CHECKS.find(check => check.name === 'prose-commands');

/**
 * Write a minimal tree whose CLI catalog declares `trace` in its prose and lists it in the catalog only when asked.
 *
 * @param {{write: Function}} tree - Private fixture root to write into.
 * @param {boolean} listed - Whether PULLBOARD_COMMANDS names trace.
 */
function writeTree(tree, listed) {
  tree.write('apps/cli/index.js', `export const HELP = {};
export const declaredProseCommands = () => new Set(['status', 'trace']);
export const PULLBOARD_COMMANDS = Object.freeze(${listed ? "['status', 'trace']" : "['status']"});
`);
  tree.write('apps/cli/src/logic/help.js', 'export const PULLBOARD_COMMANDS = [];\n');
}

/**
 * Run git in a fixture repository with a fixed identity.
 *
 * @param {string} cwd - Repository directory.
 * @param {string[]} args - Git arguments.
 */
function git(cwd, args) {
  runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd });
}

test('gate.io-static-registry.a-catalog-fix-red-at-main: clause 1: a catalog fix red at main and green at the item head passes the prose-commands check at the head [C7,#3827]', t => {
  const tree = privateFixtureFiles('pb-prose-');
  const repo = tree.root;
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  writeTree(tree, false);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'main with the catalog missing trace']);
  assert.equal(proseCheck.run(repo, [], { apps: STATIC_APPS }).length, 1, 'main is red');
  git(repo, ['checkout', '-q', '-b', 'item']);
  writeTree(tree, true);
  git(repo, ['commit', '-q', '-am', 'list trace in the catalog']);
  assert.deepEqual(proseCheck.run(repo, [], { apps: STATIC_APPS }), [], 'the head that fixes the catalog passes although this tools copy runs from elsewhere');
  git(repo, ['checkout', '-q', 'main']);
  assert.match(proseCheck.run(repo, [], { apps: STATIC_APPS })[0], /prose command declaration differs/u, 'main stays red');
});

test('gate.io-static-registry.the-prose-commands-check-reads-help: clause 2: the prose-commands check reads HELP and PULLBOARD_COMMANDS from the tree it checks, not from its own import [C7,#3827]', t => {
  const brokenTree = privateFixtureFiles('pb-prose-broken-');
  const soundTree = privateFixtureFiles('pb-prose-sound-');
  const broken = brokenTree.root;
  const sound = soundTree.root;
  t.after(() => { rmSync(broken, { recursive: true, force: true }); rmSync(sound, { recursive: true, force: true }); });
  writeTree(brokenTree, false);
  writeTree(soundTree, true);
  assert.deepEqual(proseCheck.run(sound, [], { apps: STATIC_APPS }), [], 'a tree whose own catalog is consistent passes');
  assert.equal(proseCheck.run(broken, [], { apps: STATIC_APPS }).length, 1, 'a tree whose catalog differs from its declarations fails');
  assert.match(proseCheck.run(broken, [], { apps: STATIC_APPS })[0], /^apps\/cli\/src\/logic\/help\.js:1: /u);
});

test('gate.io-static-registry.case-8460-clause-1-the-worker-bundle: #8460 clause 1: the worker-bundle check reports the measured size and its change against the record, and never refuses a bundle over it [C7]', t => {
  const bundleCheck = STATIC_TREE_CHECKS.find(check => check.name === 'worker-bundle');
  assert.ok(bundleCheck, 'the worker-bundle check is registered');
  const tree = privateFixtureFiles('pb-worker-bundle-');
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  tree.write('packages/runners/index.js', 'export const workerBundleBytes = () => 1000;\n');
  tree.write('package.json', '{}\n'); // the check's cache key reads the tree's manifest
  const reported = [];
  const context = { cache: () => ({ get: (name, scope, compute) => compute(), save() {} }), report: line => reported.push(line) };
  tree.write('packages/gate/data/ceilings/worker-bundle.json', JSON.stringify({ bytes: 999 }) + '\n');
  assert.deepEqual(bundleCheck.run(tree.root, [], context), [], 'over the record is no finding');
  assert.match(reported.at(-1), /1000 raw bytes, \+1 against the recorded 999/u);
  tree.write('packages/gate/data/ceilings/worker-bundle.json', JSON.stringify({ bytes: 1000 }) + '\n');
  assert.deepEqual(bundleCheck.run(tree.root, [], context), [], 'at the record it passes');
  assert.match(reported.at(-1), /1000 raw bytes, unchanged from the recorded 1000/u);
});

test('gate.io-static-registry.case-5642-clause-1-a-worker-bundle: 5642 clause 1: a worker-bundle measurement that fails names the step it reached and its error [C7]', t => {
  const bundleCheck = STATIC_TREE_CHECKS.find(check => check.name === 'worker-bundle');
  const tree = privateFixtureFiles('pb-worker-bundle-step-');
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  tree.write('packages/runners/index.js', "export const workerBundleBytes = (root, entry, step) => { step('list the package files'); throw new Error('walk failed'); };\n");
  tree.write('package.json', '{}\n');
  tree.write('packages/gate/data/ceilings/worker-bundle.json', JSON.stringify({ bytes: 1001 }) + '\n');
  assert.match(bundleCheck.run(tree.root)[0] ?? '', /could not be measured at the step: list the package files: Error: walk failed$/u);
});

test('gate.io-static-registry.case-8469-clause-1-a-static-run: #8469 clause 1: a static run whose only output is the worker size report line is green [C7]', t => {
  const tree = privateFixtureFiles('pb-static-report-');
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  const run = runShell(tree.root, "echo 'runner worker bundle: 840493 raw bytes, -73 against the recorded 840566 (reported, not enforced)' >&2");
  assert.equal(run.isGreen, true, 'a report line is not a finding');
  assert.match(run.output, /reported, not enforced/u, 'the line is still printed');
});
