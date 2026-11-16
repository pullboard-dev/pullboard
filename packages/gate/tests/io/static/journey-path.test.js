/** @pullboard-test-input source-cell packages/gate */
/** The static check refuses an added CLI journey no golden user path names, only with tests.requireJourneyPath on [C7,#9403]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../fixtures/child.js';

const check = STATIC_TREE_CHECKS.find(row => row.name === 'journey-path');
const GOLDEN = 'packages/gate/data/tests/golden.json';

/**
 * Run git in a fixture repository with a fixed identity.
 *
 * @param {string} cwd - Repository directory.
 * @param {string[]} args - Git arguments.
 */
function git(cwd, args) {
  runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd });
}

/**
 * A main holding a registered cell, one golden journey and one other journey; the item branch applies `edit` and commits.
 *
 * @param {import('node:test').TestContext} t
 * @param {(write: (path: string, text: string) => void) => void} edit - Changes the branch makes.
 * @returns {string} Fixture root.
 */
function change(t, edit) {
  const tree = privateFixtureFiles('pb-journey-path-');
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  git(tree.root, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  tree.write(GOLDEN, JSON.stringify({ paths: [{ path: 'init', file: 'apps/cli/journeys/init/gate.test.js' }] }));
  tree.write('packages/spec/tests/registry.json', '{"spec.old.ok":{}}\n');
  tree.write('apps/cli/journeys/init/gate.test.js', "test('init', () => {});\n");
  tree.write('apps/cli/journeys/old/walk.test.js', "test('old', () => {});\n");
  git(tree.root, ['add', '-A']);
  git(tree.root, ['commit', '-q', '-m', 'main']);
  git(tree.root, ['checkout', '-q', '-b', 'item']);
  edit(tree.write);
  git(tree.root, ['add', '-A']);
  git(tree.root, ['commit', '-q', '-m', 'item']);
  return tree.root;
}

test('clause 1: with tests.requireJourneyPath on, an added journey no golden path names fails with JOURNEY_NO_PATH naming the file, the golden list and one next step [C7,#9403]', t => {
  const root = change(t, write => write('apps/cli/journeys/fresh/walk.test.js', "test('fresh', () => {});\n"));
  const rows = check.run(root, [], { requireJourneyPath: true, report: () => {} });
  assert.equal(rows.length, 1);
  assert.match(rows[0], /^apps\/cli\/journeys\/fresh\/walk\.test\.js: JOURNEY_NO_PATH: /u, 'the rule code and the file');
  assert.match(rows[0], /golden paths: apps\/cli\/journeys\/init\/gate\.test\.js;/u, 'the golden paths list');
  assert.match(rows[0], /; next: use a cell test, or ask the coordinator to add a user path/u, 'one next step');
});

test('clause 2: an added cell test or an edited journey passes with the setting on, and with it off an added journey prints only a diagnostic line [C7,#9403]', t => {
  const quiet = change(t, write => {
    write('packages/spec/tests/new.test.js', "test('spec.old.ok: fine', () => {});\n");
    write('apps/cli/journeys/old/walk.test.js', "test('old', () => {});\n// edited\n");
  });
  assert.deepEqual(check.run(quiet, [], { requireJourneyPath: true, report: () => {} }), []);
  const named = change(t, write => write('apps/cli/journeys/init/second.test.js', "test('second', () => {});\n"));
  assert.equal(check.run(named, [], { requireJourneyPath: true, report: () => {} }).length, 1, 'only golden.json names a path');
  const off = change(t, write => write('apps/cli/journeys/fresh/walk.test.js', "test('fresh', () => {});\n"));
  const lines = [];
  assert.deepEqual(check.run(off, [], { requireJourneyPath: false, report: line => lines.push(line) }), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^diagnostic \(tests\.requireJourneyPath off\): apps\/cli\/journeys\/fresh\/walk\.test\.js: JOURNEY_NO_PATH /u);
});
