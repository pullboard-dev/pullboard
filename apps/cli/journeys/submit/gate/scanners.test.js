/** @pullboard-test-input source-tree */
/**
 * @pullboard-world-pin reads the repository clock scanner's own source to prove it declares its test-tree input.
 * Computed-import declarations and the scanners that read test files and sources: one slice of the submit gate proof, split from gate.test.js to stay under the runner time budget [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
} from '../../../tests/fixtures/child.js';
import {
  appendFileSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  selectAffectedTests,
} from '../../../../../packages/gate/index.js';
import {
  copyRepositoryFixture,
} from './local.js';
import {
  privateRepo,
  put,
  commitAll,
  seedGraph,
} from '../../../tests/fixtures/submit/gate.js';
import {
  test,
} from 'node:test';

test('clause 1: a computed-import test joins the selection only when it declares what it loads, and undeclared forces full [V4,C7]', async (t) => {
  const box = privateRepo(t);
  const original = seedGraph(box);
  put(box.root, 'test/c.test.js', "export const load = path => import(path);\n");
  const base = commitAll(box);
  const added = selectAffectedTests(box.root, { base: original, commit: base, changed: ['src/a.js'] });
  // Since a9d9045aa4 one unreadable test always runs its own file and never selects the whole suite.
  assert.equal(added.full, false, 'an undeclared computed import cannot be read, so its own file runs, not the whole suite');
  assert.ok(added.files.includes('test/c.test.js'), 'the unreadable loader always runs');
  assert.match(added.reason, /test\/c\.test\.js/u, 'the reason names the undeclared file');
  put(box.root, 'test/c.test.js', "/** @pullboard-test-loads src/a.js */\nexport const load = path => import(path);\n");
  const declared = commitAll(box, 'test(core): declare what the loader reads [G1]');
  put(box.root, 'src/a.js', 'export const value = 2;\n'); let commit = commitAll(box, 'feat(core): source change [G1]');
  let selection = selectAffectedTests(box.root, { base: declared, commit }); assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js', 'test/c.test.js'], 'a declared loader of the changed module is selected');
  selection = selectAffectedTests(box.root, { base: declared, commit, changed: ['test/c.test.js'] });
  assert.equal(selection.full, false, 'reaching a computed-import test does not force full'); assert.deepEqual(selection.files, ['test/c.test.js']);
  put(box.root, 'test/c.test.js', "import 'node:assert/strict';\n");
  commit = commitAll(box, 'test(core): remove computed loader [G1]');
  selection = selectAffectedTests(box.root, { base: declared, commit, changed: ['src/a.js'] });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js', 'test/c.test.js'], 'the old graph keeps its declared loader selected');
});


/** Test-tree readers are data dependencies even when no import reaches their scanner. */
test('a changed test file selects the scanners that read test files [C7,B3]', async (t) => {
  const box = privateRepo(t);
  seedGraph(box);
  const declaration = '/** @pullboard-test-input test-tree */\n';
  put(box.root, 'test/chrome-fixture.test.js', "import 'node:assert/strict';\n");
  put(box.root, 'test/wall-clock-budgets.test.js', declaration + "import 'node:assert/strict';\n");
  put(box.root, 'test/nested/reader.test.mjs', declaration + "import 'node:fs';\n");
  put(box.root, 'test/comment-only.test.js', "const text = '/** @pullboard-test-input test-tree */';\n");
  const base = commitAll(box);
  put(box.root, 'test/chrome-fixture.test.js', "import 'node:assert/strict';\n// changed test behavior\n");
  const commit = commitAll(box, 'test(core): change browser regression [G1]');
  const expected = ['test/chrome-fixture.test.js', 'test/nested/reader.test.mjs', 'test/wall-clock-budgets.test.js'];
  const selection = selectAffectedTests(box.root, { base, commit });
  assert.equal(selection.full, false, 'declared scanners add their own files without selecting unrelated tests');
  assert.deepEqual(selection.files, expected, 'a change only to the browser test selects the real scanner names');
  assert.ok(readFileSync(join(import.meta.dirname, '../../../../../packages/gate/tests/io/budgets.test.js'), 'utf8').startsWith(declaration),
    'the repository clock scanner declares its test-tree input');
  for (const path of ['test/support.js', 'test/new.test.js', 'test.js']) {
    assert.deepEqual(selectAffectedTests(box.root, { base, commit, changed: [path] }).files,
      expected.filter(file => file !== 'test/chrome-fixture.test.js'), path + ' changes the scanner input tree');
  }
  assert.deepEqual(selectAffectedTests(box.root, { base, commit, changed: ['src/a.js'] }).files, ['test/a.test.js'],
    'a source-only change keeps the normal import closure');
  put(box.root, 'test/wall-clock-budgets.test.js', "import 'node:assert/strict';\n");
  const removed = commitAll(box, 'test(core): remove scanner declaration [G1]');
  assert.deepEqual(selectAffectedTests(box.root, { base: commit, commit: removed, changed: ['test/chrome-fixture.test.js'] }).files,
    expected, 'the old graph retains a scanner whose declaration was removed');

  // Use committed repository sources so a real scanner cannot be replaced by a synthetic stand-in.
  const repository = resolve(import.meta.dirname, '../../../../..');
  const actual = privateRepo(t);
  const tracked = execFileSync('git', ['ls-files', '-z', 'src/', 'test/', 'apps/cli/journeys/hold/', 'packages/gate/tests/'], {
    cwd: repository, encoding: 'utf8',
  }).split('\0').filter(path => /\.[cm]?js$/u.test(path));
  const actualBase = copyRepositoryFixture(actual, repository, tracked);
  appendFileSync(join(actual.root, 'apps/cli/journeys/hold/demo.test.js'), '\n// Only the cockpit input changes.\n');
  const actualCommit = commitAll(actual, 'test(core): change cockpit input [G1]');
  assert.deepEqual(actual.git('diff', '--name-only', actualBase, actualCommit).split('\n'),
    ['apps/cli/journeys/hold/demo.test.js'], 'the real-source fixture changes only the cockpit test');
  const actualSelection = selectAffectedTests(actual.root, { base: actualBase, commit: actualCommit });
  assert.equal(actualSelection.full, false, 'a cockpit-only input keeps affected selection');
  for (const scanner of ['packages/gate/tests/io/board/baseline/guard.test.js', 'packages/gate/tests/logic/wait.test.js',
    'packages/gate/tests/io/budgets.test.js']) {
    assert.ok(actualSelection.files.includes(scanner), 'actual test-tree reader selected: ' + scanner);
  }
});

/** Source-tree declarations cover text scanners without broadening unrelated import closures. */
test('a source change selects the tests that scan sources [C7,B3]', async (t) => {
  const box = privateRepo(t);
  seedGraph(box);
  const sourceInput = '/** @pullboard-test-input source-tree */\n';
  const testInput = '/** @pullboard-test-input test-tree */\n';
  put(box.root, 'test/scanner.test.js', sourceInput + "import 'node:fs';\n");
  put(box.root, 'test/both.test.js', testInput + sourceInput + "import 'node:fs';\n");
  put(box.root, 'test/nested/both.test.mjs', (sourceInput + testInput).replaceAll('\n', '\r\n') + "import 'node:fs';\n");
  put(box.root, 'test/tests-only.test.js', testInput + "import 'node:fs';\n");
  put(box.root, 'test/quoted.test.js', "const text = '/** @pullboard-test-input source-tree */';\n");
  put(box.root, 'test/late.test.js', "const alreadyExecuting = true;\n" + sourceInput);
  const base = commitAll(box);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  const commit = commitAll(box, 'feat(core): change source scanner input [G1]');
  const readers = ['test/both.test.js', 'test/nested/both.test.mjs', 'test/scanner.test.js'];
  const selection = selectAffectedTests(box.root, { base, commit });
  assert.equal(selection.full, false, 'scanner declarations keep affected selection');
  assert.deepEqual(selection.files, ['test/a.test.js', ...readers].sort(),
    'the source change adds declared scanners to its normal import closure');
  for (const path of ['src/new.js', 'bin/tool.mjs']) {
    assert.deepEqual(selectAffectedTests(box.root, { base, commit, changed: [path] }).files, readers,
      path + ' selects scanners without an import edge');
  }
  assert.deepEqual(selectAffectedTests(box.root, { base, commit, changed: ['test/c.test.js'] }).files,
    ['test/both.test.js', 'test/c.test.js', 'test/nested/both.test.mjs', 'test/tests-only.test.js'],
    'both declaration orders retain test-tree selection without adding source-only readers');
  assert.deepEqual(selectAffectedTests(box.root, { base, commit, changed: ['lib/unrelated.js'] }).files, [],
    'other trees keep their existing import selection');
  put(box.root, 'test/scanner.test.js', "import 'node:fs';\n");
  const removed = commitAll(box, 'test(core): remove source declaration [G1]');
  assert.deepEqual(selectAffectedTests(box.root, { base: commit, commit: removed, changed: ['src/new.js'] }).files,
    readers, 'old declarations retain readers across removal');
  put(box.root, 'test/scanner.test.js', sourceInput + "import 'node:fs';\n");
  const deletionBase = commitAll(box, 'test(core): restore scanner declaration [G1]');
  box.git('rm', 'src/a.js');
  const deleted = commitAll(box, 'refactor(core): remove source input [G1]');
  assert.deepEqual(selectAffectedTests(box.root, { base: deletionBase, commit: deleted }).files,
    ['test/a.test.js', ...readers].sort(), 'source deletion retains old importers and scanners');

  const repository = resolve(import.meta.dirname, '../../../../..');
  const actual = privateRepo(t);
  const tracked = execFileSync('git', ['ls-files', '-z', 'src/', 'bin/', 'test/', 'apps/cli/journeys/init/boundary.test.js', 'apps/cli/journeys/verify/machine.test.js', 'apps/cli/journeys/submit/gate.test.js', 'packages/'], {
    cwd: repository, encoding: 'utf8',
  }).split('\0').filter(path => /\.[cm]?js$/u.test(path));
  const actualBase = copyRepositoryFixture(actual, repository, tracked);
  put(actual.root, 'src/scanner-input.js', 'export const scannerInput = true;\n');
  const actualCommit = commitAll(actual, 'test(core): add an unimported source input [G1]');
  const actualSelection = selectAffectedTests(actual.root, { base: actualBase, commit: actualCommit });
  assert.equal(actualSelection.full, false, 'an unimported source addition keeps affected selection');
  for (const scanner of ['apps/cli/journeys/init/boundary.test.js', 'apps/cli/journeys/verify/machine.test.js', 'packages/doctrine/tests/package.test.js',
    'apps/cli/journeys/submit/gate.test.js', 'packages/gate/tests/io/budgets.test.js']) {
    assert.ok(readFileSync(join(repository, scanner), 'utf8').split(/\r?\n/u).slice(0, 2).includes(sourceInput.trimEnd()),
      'actual source-tree reader declares its input: ' + scanner);
    assert.ok(actualSelection.files.includes(scanner), 'actual source-tree reader selected: ' + scanner);
  }
});
