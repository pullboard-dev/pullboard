/** @pullboard-test-input source-tree */
/**
 * @pullboard-world-pin reads the repository clock scanner's own source to prove it declares its test-tree input.
 * Source changes select the tests that scan sources: one slice of the submit gate proof, split from gate.test.js to stay under the runner time budget [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
} from '../../../tests/fixtures/child.js';
import {
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
  const tracked = execFileSync('git', ['ls-files', '-z', 'src/', 'bin/', 'test/', 'apps/cli/journeys/init/boundary.test.js', 'apps/cli/journeys/verify/machine.test.js', 'apps/cli/journeys/submit/gate/scanner-source.test.js', 'packages/'], {
    cwd: repository, encoding: 'utf8',
  }).split('\0').filter(path => /\.[cm]?js$/u.test(path));
  const actualBase = copyRepositoryFixture(actual, repository, tracked);
  put(actual.root, 'src/scanner-input.js', 'export const scannerInput = true;\n');
  const actualCommit = commitAll(actual, 'test(core): add an unimported source input [G1]');
  const actualSelection = selectAffectedTests(actual.root, { base: actualBase, commit: actualCommit });
  assert.equal(actualSelection.full, false, 'an unimported source addition keeps affected selection');
  for (const scanner of ['apps/cli/journeys/init/boundary.test.js', 'apps/cli/journeys/verify/machine.test.js', 'packages/doctrine/tests/package.test.js',
    'apps/cli/journeys/submit/gate/scanner-source.test.js', 'packages/gate/tests/io/budgets.test.js']) {
    assert.ok(readFileSync(join(repository, scanner), 'utf8').split(/\r?\n/u).slice(0, 2).includes(sourceInput.trimEnd()),
      'actual source-tree reader declares its input: ' + scanner);
    assert.ok(actualSelection.files.includes(scanner), 'actual source-tree reader selected: ' + scanner);
  }
});
