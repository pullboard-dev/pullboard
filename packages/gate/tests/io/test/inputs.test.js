/** A test-input header names cells, and selection reruns that test only for a change in a named cell [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { selectAffectedTests } from '../../../index.js';
import { declaresSource } from '../../../src/io/test/inputs.js';
import { testInputProblems } from '../../../src/io/test/inputs.js';

const READ = "import { readdirSync } from 'node:fs';\nreaddirSync(new URL('../src', import.meta.url));\n";

/** A real Git repository with one test that names the gate cell and one that reads the whole source tree. */
function repository(t) {
  const root = privateFixtureFiles('pullboard-cell-inputs-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const run = (...args) => runFixtureGit(args, { cwd: root, env });
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  run('init', '-q', '-b', 'main');
  put('package.json', '{"type":"module"}\n');
  put('packages/gate/src/a.js', 'export const a = 1;\n');
  put('packages/state/src/b.js', 'export const b = 1;\n');
  put('apps/cli/src/c.js', 'export const c = 1;\n');
  put('packages/gate/tests/cell.test.js', `/** @pullboard-test-input source-cell gate */\n${READ}`);
  put('packages/gate/tests/multi.test.js', `/** @pullboard-test-input source-cell packages/state apps/cli */\n${READ}`);
  put('packages/gate/tests/tree.test.js', `/** @pullboard-test-input source-tree */\n${READ}`);
  put('packages/gate/tests/bad.test.js', `/** @pullboard-test-input source-cell */\n${READ}`);
  run('add', '-A'); run('commit', '-qm', 'chore: fixture');
  return { root, base: run('rev-parse', 'HEAD').trim() };
}

test('gate.io-test-inputs.a-test-naming-a-cell-reruns: a test naming a cell reruns only for a change in that cell [C7,V4]', t => {
  const { root, base } = repository(t);
  const gate = selectAffectedTests(root, { base, commit: base, changed: ['packages/gate/src/a.js'] });
  assert.ok(gate.files.includes('packages/gate/tests/cell.test.js'));
  assert.ok(!gate.files.includes('packages/gate/tests/multi.test.js'));
  const state = selectAffectedTests(root, { base, commit: base, changed: ['packages/state/src/b.js'] });
  assert.ok(!state.files.includes('packages/gate/tests/cell.test.js'));
  assert.ok(state.files.includes('packages/gate/tests/multi.test.js'));
  const app = selectAffectedTests(root, { base, commit: base, changed: ['apps/cli/src/c.js'] });
  assert.ok(app.files.includes('packages/gate/tests/multi.test.js'));
  assert.ok(!app.files.includes('packages/gate/tests/cell.test.js'));
});

test('gate.io-test-inputs.a-plain-source-tree-header-still: a plain source-tree header still reads every cell [C7,V4]', t => {
  const { root, base } = repository(t);
  for (const changed of ['packages/gate/src/a.js', 'packages/state/src/b.js', 'apps/cli/src/c.js']) {
    const selection = selectAffectedTests(root, { base, commit: base, changed: [changed] });
    assert.ok(selection.files.includes('packages/gate/tests/tree.test.js'), changed);
  }
});

test('gate.io-test-inputs.the-source-read-rigor-check-accepts: the source-read rigor check accepts a source-cell header and refuses a malformed one [C7]', () => {
  assert.equal(declaresSource('/** @pullboard-test-input source-cell gate */\nx\n'), true);
  assert.equal(declaresSource('/** @pullboard-test-input source-cell */\nx\n'), false);
});

const FIXTURE_READ = "import { readFileSync } from 'node:fs';\nreadFileSync(new URL('../tests/fixtures/a.json', import.meta.url));\n";
const DOCS_READ = "import { readFileSync } from 'node:fs';\nconst x = 1;\nreadFileSync(new URL('../../docs/a.md', import.meta.url));\n";

test('gate.io-test-inputs.with-the-setting-on-an-undeclared: clause 1: with the setting on, an undeclared read under tests/fixtures, data or docs is reported at its first such line [C7,#9801]', () => {
  const files = { 'a.test.js': FIXTURE_READ, 'b.test.js': DOCS_READ, 'c.test.js': `/** @pullboard-test-input docs-tree */\n${DOCS_READ}` };
  const problems = testInputProblems('/unused', Object.keys(files), path => files[path], true);
  assert.deepEqual(problems.map(p => [p.path, p.line]), [['a.test.js', 2], ['b.test.js', 3]]);
});

test('gate.io-test-inputs.with-the-setting-off-the-same: clause 2: with the setting off the same files are not reported [C7,#9801]', () => {
  const files = { 'a.test.js': FIXTURE_READ, 'b.test.js': DOCS_READ };
  assert.deepEqual(testInputProblems('/unused', Object.keys(files), path => files[path], false), []);
});
