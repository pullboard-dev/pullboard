/** @pullboard-test-input source-tree */
/** A run says per test file whether it ran or reused a cached green, its key, and which input missed [C7]. */
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';
import { cacheSummary } from '../../../../src/io/test/account.js';
import { readCacheRows } from '../../../../src/io/test/account.js';
import { renderTestSummary } from '../../../../src/io/test/summary.js';

/** A fixture test that passes when its module says green. */
function fixtureTest(module) {
  return `import { test } from 'node:test';
import { value } from '../lib/${module}.js';
/** Check the module. */
function check() { if (value !== 'green') throw new Error('${module} is red'); }
test('gate.io-test-account-receipts.module: ${module} [C7]', check);
`;
}

/** Copy the tool's shipped source (bin, src, packages, apps, skills, docs, minus cell tests) into `to`; gate cannot import the runners door that does this for the cells above it. */
function copyShippedTool(from, to) {
  const listed = runFixtureGit(['ls-files', '-co', '--exclude-standard', '-z', '--', 'bin', 'src', 'packages', 'apps', 'skills', 'docs'], { cwd: from }).split('\0');
  const files = listed.filter(file => file && existsSync(join(from, file)) && !/^[^/]+\/[^/]+\/tests\//u.test(file) && !/^docs\/.*\.test\.js$/u.test(file));
  for (const file of files) {
    mkdirSync(dirname(join(to, file)), { recursive: true });
    copyFileSync(join(from, file), join(to, file));
  }
  return files;
}

/** A committed scratch repository with the real runner, two tests and their modules: A imports shared, B stands alone. */
function makeFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-cache-receipts-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ['bin', 'lib', 'test', 'machine']) mkdirSync(join(root, folder));
  const copied = copyShippedTool(resolve(import.meta.dirname, '../../../../../..'), root);
  /** Escape one copied-tool path for an anchored ignore line. */
  const ignore = file => '/' + [...file].map(char => ('\\*?[]!# '.includes(char) ? '\\' + char : char)).join('');
  writeFileSync(join(root, '.gitignore'), ['bin/', 'src/', 'machine/', ...copied.filter(file => !['package.json', 'CHANGELOG.md'].includes(file)).map(ignore)].join('\n') + '\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, 'lib', 'shared.js'), "export const shared = 'green';\n");
  writeFileSync(join(root, 'lib', 'a.js'), "import { shared } from './shared.js';\nexport const value = shared;\n");
  writeFileSync(join(root, 'lib', 'b.js'), "export const value = 'green';\n");
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n');
  for (const name of ['a', 'b']) writeFileSync(join(root, `test/${name}.test.js`), fixtureTest(name));
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: join(root, 'machine'), PULLBOARD_LANDING_RUN: '0',
    GIT_AUTHOR_NAME: 'Cache Fixture', GIT_AUTHOR_EMAIL: 'cache@example.test', GIT_COMMITTER_NAME: 'Cache Fixture', GIT_COMMITTER_EMAIL: 'cache@example.test' };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_TEST_STAGE', 'PULLBOARD_TEST_ACTIONS', 'PULLBOARD_TEST_REUSE', 'PULLBOARD_TEST_RESULT_STORE', 'PULLBOARD_TEST_RESULT_ORIGIN', 'PULLBOARD_TEST_CACHE_TOOLING']) delete env[key];
  /** Run one fixture git command under the private environment. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  git('init', '-q', '-b', 'main');
  git('add', '.gitignore', 'package.json', 'CHANGELOG.md', 'lib', 'test');
  const copiedIgnores = copied.filter(file => file.endsWith('/.gitignore'));
  if (copiedIgnores.length) git('add', '-f', '--', ...copiedIgnores);
  git('commit', '-q', '-m', 'fixture');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'the fixture starts with a clean worktree, so the planner may reuse');
  /** Commit one file's new text. */
  const change = (path, text) => { writeFileSync(join(root, path), text); git('add', '-f', '--', path); git('commit', '-q', '-m', `change ${path}`, '--', path); };
  /** Run both tests through the real runner; return its status, output and parsed cache account. */
  const run = () => {
    const result = runFixtureChild(process.execPath, ['apps/cli/src/io/run/tests.js', 'test/a.test.js', 'test/b.test.js'], { cwd: root, env, encoding: 'utf8', timeout: 25_000 });
    const output = `${result.stdout}\n${result.stderr}`;
    return { status: result.status, output, account: readCacheRows(output) };
  };
  return { change, run };
}

test('gate.io-test-account-receipts.a-file-run-twice-unchanged-is: clause 1: a file run twice unchanged is reused, and after an import edit it ran and names the import [C7]', (t) => {
  const fixture = makeFixture(t);
  const first = fixture.run();
  assert.equal(first.status, 0, first.output);
  assert.deepEqual(first.account.rows.map(row => [row.file, row.outcome, row.missed]),
    [['test/a.test.js', 'ran', 'no earlier key'], ['test/b.test.js', 'ran', 'no earlier key']]);
  assert.match(first.account.rows[0].key, /^[0-9a-f]{64}$/u, 'each row carries its action key');

  const second = fixture.run();
  assert.equal(second.status, 0, second.output);
  assert.deepEqual(second.account.rows.map(row => [row.file, row.outcome, row.missed]),
    [['test/a.test.js', 'reused', null], ['test/b.test.js', 'reused', null]]);
  assert.equal(second.account.rows[0].key, first.account.rows[0].key, 'an unchanged file keeps its key');

  fixture.change('lib/shared.js', "export const shared = 'green'; // edited\n");
  const third = fixture.run();
  assert.equal(third.status, 0, third.output);
  const a = third.account.rows.find(row => row.file === 'test/a.test.js');
  assert.equal(a.outcome, 'ran');
  assert.equal(a.missed, 'import lib/shared.js', 'the missed input is the edited import');
  assert.notEqual(a.key, first.account.rows[0].key);
  assert.equal(third.account.rows.find(row => row.file === 'test/b.test.js').outcome, 'reused');

  fixture.change('test/b.test.js', `${fixtureTest('b')}// edited\n`);
  const fourth = fixture.run();
  assert.equal(fourth.account.rows.find(row => row.file === 'test/b.test.js').missed, 'file', 'an edit to the file itself is named as the file');
});

test('gate.io-test-account-receipts.the-run-prints-one-summary-line: clause 2: the run prints one summary line with the reused and ran counts and the top missed inputs [C7]', (t) => {
  const fixture = makeFixture(t);
  fixture.run();
  fixture.change('lib/shared.js', "export const shared = 'green'; // edited\n");
  const run = fixture.run();
  assert.equal(run.status, 0, run.output);
  assert.equal(run.output.match(/^# test cache: .*$/gmu).length, 1, 'exactly one summary line');
  assert.match(run.output, /^# test cache: 2 files, 1 reused, 1 ran; top missed inputs: import lib\/shared\.js \(1\)$/mu);
  assert.equal(run.account.summary, 'test cache: 2 files, 1 reused, 1 ran; top missed inputs: import lib/shared.js (1)');

  assert.equal(cacheSummary([{ outcome: 'reused', missed: null }]), 'test cache: 1 files, 1 reused, 0 ran; top missed inputs: none');
  const rows = [['package.json', 'ran'], ['package.json', 'ran'], ['node', 'ran'], ['x', 'reused']].map(([missed, outcome]) => ({ outcome, missed }));
  assert.equal(cacheSummary(rows), 'test cache: 4 files, 1 reused, 3 ran; top missed inputs: package.json (2), node (1)');
  const rendered = renderTestSummary({ counts: { passed: 2, failed: 0, skipped: 0 }, cache: run.account.summary, failures: [], logPath: '/x' });
  assert.match(rendered, /^2 passed, 0 failed, 0 skipped\ntest cache: 2 files, 1 reused, 1 ran; top missed inputs: /u, 'pullboard test shows the line under its counts');
});
