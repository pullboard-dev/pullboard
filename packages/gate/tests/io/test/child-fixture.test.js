/** @pullboard-test-input source-cell gate */
/** The static stage refuses a new package test importing the CLI child fixture, and only a new one [C7,#8435]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';
import { cliChildImportProblems } from '../../../src/io/test/child-fixture.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureSetupGit } from '../../fixtures/child.js';

const FIXTURE = ['apps', 'cli', 'tests', 'fixtures', 'child.js'].join('/');
const IMPORT = `import { privateFixtureFiles } from '../../../${FIXTURE}';\n`;
const PLAIN = "import { test } from 'node:test';\ntest('x', () => {});\n";

/** A repo whose main holds one old importer and one plain test, with the branch checked out. */
function repo(t) {
  const files = privateFixtureFiles('pb-child-import-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  files.write('packages/a/tests/old.test.js', IMPORT);
  files.write('packages/a/tests/plain.test.js', PLAIN);
  const step = (...args) => runFixtureSetupGit(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: files.root });
  step('init', '-q', '-b', 'main');
  step('add', '-A');
  step('commit', '-q', '-m', 'main');
  step('checkout', '-q', '-b', 'branch');
  return { files, commit: () => { step('add', '-A'); step('commit', '-q', '-m', 'branch'); } };
}

test('gate.io-test-child-fixture.a-branch-that-adds-a-cell: clause 1: a branch that adds a cell test importing the CLI child fixture outside the exception list is reported [C7]', t => {
  const { files, commit } = repo(t);
  files.write('packages/b/tests/new.test.js', `/** a new test */\n${IMPORT}`);
  commit();
  const rows = cliChildImportProblems(files.root, { exceptions: [] });
  assert.deepEqual(rows.map(row => `${row.path}:${row.line}`), ['packages/b/tests/new.test.js:2']);
  assert.match(rows[0].text, /package tests import packages\/gate\/tests\/fixtures\/child\.js directly/u);
  const named = STATIC_TREE_CHECKS.find(check => check.name === 'cli-child-import').run(files.root, [], { changed: null });
  assert.ok(named.some(row => row.startsWith('packages/b/tests/new.test.js:2:')), JSON.stringify(named));
  assert.deepEqual(cliChildImportProblems(files.root, { exceptions: ['b/tests/new.test.js'] }), [], 'a named exception is allowed');
});

test('gate.io-test-child-fixture.a-branch-that-adds-no-such: clause 2: a branch that adds no such import gets no finding, even though main already carries one [C7]', t => {
  const { files, commit } = repo(t);
  files.write('packages/b/tests/other.test.js', PLAIN);
  commit();
  assert.deepEqual(cliChildImportProblems(files.root, { exceptions: [] }), []);
});
