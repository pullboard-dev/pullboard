/** @pullboard-test-input source-cell packages/gate */
/** The static check refuses a change that adds a test file with no registry, only with tests.requireRegistered on [C7,U148,#9402]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../fixtures/child.js';

const check = STATIC_TREE_CHECKS.find(row => row.name === 'test-registered');

/**
 * Run git in a fixture repository with a fixed identity.
 *
 * @param {string} cwd - Repository directory.
 * @param {string[]} args - Git arguments.
 */
function git(cwd, args) {
  runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd });
}

/** A main holding one registered cell and one existing test; the item branch then edits that test and adds a test in an unregistered cell. */
function change(t) {
  const tree = privateFixtureFiles('pb-test-registered-');
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  git(tree.root, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  tree.write('packages/spec/tests/registry.json', '{"spec.old.ok":{}}\n');
  tree.write('packages/spec/tests/old.test.js', "test('spec.old.ok: fine', () => {});\n");
  git(tree.root, ['add', '-A']);
  git(tree.root, ['commit', '-q', '-m', 'main']);
  git(tree.root, ['checkout', '-q', '-b', 'item']);
  tree.write('packages/spec/tests/old.test.js', "test('spec.old.ok: fine', () => {});\n// edited\n");
  tree.write('packages/other/tests/new.test.js', "test('other.new.ok: fine', () => {});\n");
  git(tree.root, ['add', '-A']);
  git(tree.root, ['commit', '-q', '-m', 'item']);
  return tree.root;
}

test('clause 1: with tests.requireRegistered on, a new test file in a cell with no registry fails with TEST_UNREGISTERED naming the file and one next step; an edited test does not [C7,U148]', t => {
  const root = change(t);
  const rows = check.run(root, [], { requireRegistered: true, report: () => {} });
  assert.equal(rows.length, 1, 'only the added file is a finding');
  assert.match(rows[0], /^packages\/other\/tests\/new\.test\.js: TEST_UNREGISTERED /u);
  assert.match(rows[0], /; next: create packages\/other\/tests\/registry\.json/u, 'one next step');
  assert.ok(!rows.some(row => row.includes('packages/spec/tests/old.test.js')), 'a modified test file never trips it');
});

test('clause 2: with tests.requireRegistered off the same change passes and the finding is only a diagnostic line [C7,U148]', t => {
  const root = change(t);
  const lines = [];
  assert.deepEqual(check.run(root, [], { requireRegistered: false, report: line => lines.push(line) }), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /diagnostic \(tests\.requireRegistered off\): packages\/other\/tests\/new\.test\.js: TEST_UNREGISTERED /u);
});
