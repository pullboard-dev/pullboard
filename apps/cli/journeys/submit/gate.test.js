/** @pullboard-test-input source-tree */
/**
 * Submit without a frozen check, CommonJS fallbacks, scanner selection, merge-base reads, sandbox-blocked asks and the static style
 * first order: the second half of the submit gate proof, split from submit-gate.test.js to stay under the test file budget [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
  runFixtureChild,
} from '../../tests/fixtures/child.js';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import {
  selectAffectedTests,
  startDiagnostics,
} from '../../../../packages/gate/index.js';
import { checkAtCommit } from '../../../runner/index.js';
import {
  refuseSandboxBlocked,
  sandboxBlockedOperation,
} from '../../../../packages/gate/index.js';
import { coordinatorLocal } from './gate/local.js';
import { runLocal } from './gate/local.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { SPEC } from '../../tests/fixtures/submit/gate.js';
import { privateRepo } from '../../tests/fixtures/submit/gate.js';
import { builderRepo } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { seedGraph } from '../../tests/fixtures/submit/gate.js';

/** Copy the real module graph in bounded commits while retaining every installed hook and secret scan. */
function copyRepositoryFixture(box, repository, tracked) {
  // New-file diffs add one prefix per line and small path headers. Leave half the real scan limit free.
  const batchBytes = 4 * 1024 * 1024;
  let stagedBytes = 0;
  let pending = false;
  let head;
  for (const path of tracked) {
    const source = readFileSync(join(repository, path), 'utf8');
    const estimate = Buffer.byteLength(source) + source.split('\n').length + 512 + 2 * Buffer.byteLength(path);
    assert.ok(estimate <= batchBytes, `one copied module exceeds the fixture batch limit: ${path}`);
    if (pending && stagedBytes + estimate > batchBytes) {
      head = commitAll(box); stagedBytes = 0; pending = false;
    }
    put(box.root, path, source);
    stagedBytes += estimate; pending = true;
  }
  return pending ? commitAll(box) : head;
}

test('submit without a frozen check reports no item check and still runs affected tests [V4,C7,V16]', async (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
  put(box.root, 'src/a.js', 'export const value = 1;\n');
  put(box.root, 'test/a.test.js', "import '../src/a.js'; import { appendFileSync } from 'node:fs'; appendFileSync(process.env.AFFECTED_MARKER, 'ran');\n");
  put(box.root, 'test/b.test.js', "import assert from 'node:assert/strict'; assert.fail('unrelated');\n");
  commitAll(box);
  box = builderRepo(box);
  assert.equal((await coordinatorLocal(box, 'add', 'build', 'No frozen command')).code, 0);
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): update selected source [G1]');
  const marker = join(box.dir, 'without-check.log');
  box.env.AFFECTED_MARKER = marker;
  const result = await runLocal(box, 'submit', '1', '--json');
  assert.equal(result.code, 0, result.err);
  const receipt = JSON.parse(result.out);
  assert.match(receipt.gate.report, /no item check/u);
  assert.equal(receipt.gate.check.checked, false);
  assert.equal(receipt.gate.full, false);
  assert.deepEqual(receipt.gate.files, ['test/a.test.js']);
  assert.ok(existsSync(marker), 'the affected test ran without an item check');
  assert.equal(readFileSync(marker, 'utf8'), 'ran');
});

test('a red frozen item check refuses submit before affected tests run [V4,C7,V16]', async (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
  seedGraph(box);
  box = builderRepo(box);
  const added = await coordinatorLocal(box, 'add', 'build', 'Frozen check', '--check', 'node -e "process.exit(process.env.CHECK_REFUSE ? 1 : 0)"');
  assert.equal(added.code, 0, added.err);
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): update selected source [G1]');
  box.env.CHECK_REFUSE = '1';
  const refused = await runLocal(box, 'submit', '1');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.err + refused.out, /GATE_RED/u);
  assert.match(refused.err, /item check red/u);
});


test('CommonJS and nested package scopes fall back instead of silently missing require edges [V4,V16]', async (t) => {
  const common = privateRepo(t);
  put(common.root, 'package.json', '{"type":"commonjs"}\n');
  put(common.root, 'src/a.js', 'module.exports = 1;\n');
  put(common.root, 'test/a.test.js', "require('../src/a.js');\n");
  put(common.root, 'test/b.test.js', "require('node:assert/strict').ok(true);\n");
  const base = commitAll(common);
  put(common.root, 'src/a.js', 'module.exports = 2;\n');
  const commit = commitAll(common, 'feat(core): change CommonJS source [G1]');
  const selection = selectAffectedTests(common.root, { base, commit });
  assert.equal(selection.full, true, 'require import edges cannot be silently omitted');
  assert.match(selection.reason, /CommonJS|package scope/u);

  const nested = privateRepo(t);
  seedGraph(nested);
  put(nested.root, 'legacy/package.json', '{"type":"commonjs"}\n');
  put(nested.root, 'legacy/value.js', 'module.exports = 1;\n');
  const nestedBase = commitAll(nested);
  put(nested.root, 'legacy/value.js', 'module.exports = 2;\n');
  const nestedCommit = commitAll(nested, 'feat(core): change nested CommonJS source [G1]');
  const scoped = selectAffectedTests(nested.root, { base: nestedBase, commit: nestedCommit });
  assert.equal(scoped.full, true, 'nested package policy makes a single ESM graph incomplete');
  assert.match(scoped.reason, /package scope/u);

  const esm = privateRepo(t);
  const esmBase = seedGraph(esm);
  put(esm.root, 'src/a.js', "import { createRequire } from 'node:module'; export const load = createRequire(import.meta.url);\n");
  const esmCommit = commitAll(esm, 'feat(core): create a CommonJS loader [G1]');
  const loader = selectAffectedTests(esm.root, { base: esmBase, commit: esmCommit });
  assert.equal(loader.full, true, 'a reached CommonJS loader also makes the ESM import graph incomplete');
  assert.match(loader.reason, /CommonJS/u);
});


for (const mode of ['topic parent', 'merge commit']) {
  test(`affected tests include source changes carried by a ${mode} [V4,C7,V16]`, async (t) => {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
    seedGraph(box);
    put(box.root, 'test/a.test.js', [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/middle.js';",
      "appendFileSync(process.env.AFFECTED_MARKER, 'ran\\n');",
      'assert.equal(value, 1);',
    ].join('\n'));
    box = builderRepo(box);
    assert.equal((await coordinatorLocal(box, 'add', 'build', 'Merged source', '--check', 'true')).code, 0);
    assert.equal((await runLocal(box, 'claim', '1')).code, 0);
    const branch = box.git('branch', '--show-current');
    box.git('checkout', '-q', '-b', 'topic');
    put(box.root, mode === 'topic parent' ? 'src/a.js' : 'src/notes.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): topic source [G1]');
    box.git('checkout', '-q', branch);
    if (mode === 'merge commit') {
      put(box.root, 'src/other.js', 'export const other = false;\n');
      commitAll(box, 'feat(core): unrelated source [G1]');
      box.git('merge', '--no-ff', '--no-commit', 'topic');
      put(box.root, 'src/a.js', 'export const value = 2;\n');
      commitAll(box, 'feat(core): resolve merged source [G1]');
    } else box.git('merge', '--no-ff', '-q', 'topic', '-m', 'feat(core): merge topic source [G1]');
    assert.equal(box.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'the candidate really has two parents');
    const marker = join(box.dir, 'merged-test-ran.log');
    box.env.AFFECTED_MARKER = marker;
    // Process-level: the unchanged importer runs under its own node --test, not the CLI.
    const standalone = runFixtureChild(process.execPath, ['--test', 'test/a.test.js'], { cwd: box.root, env: box.env, encoding: 'utf8' });
    assert.equal(standalone.status, 1, 'the unchanged importer detects the merged source regression');
    assert.match(standalone.stdout, /ERR_ASSERTION/u);
    rmSync(marker);
    const refused = await runLocal(box, 'submit', '1');
    assert.equal(refused.code, 1, refused.out || refused.err);
    assert.match(refused.err + refused.out, /GATE_RED/u);
    assert.match(refused.err, /affected tests:.*test\/a\.test\.js/u);
    assert.match(refused.err, /ERR_ASSERTION/u);
    assert.equal(readFileSync(marker, 'utf8'), 'ran\nran\n', 'submit executes the transitive importer against the candidate and exact main');
  });
}

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
  assert.ok(readFileSync(join(import.meta.dirname, '../../../../packages/gate/tests/io/budgets.test.js'), 'utf8').startsWith(declaration),
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
  const repository = resolve(import.meta.dirname, '../../../..');
  const actual = privateRepo(t);
  const tracked = execFileSync('git', ['ls-files', '-z', 'src/', 'test/', 'packages/gate/tests/'], {
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

  const repository = resolve(import.meta.dirname, '../../../..');
  const actual = privateRepo(t);
  const tracked = execFileSync('git', ['ls-files', '-z', 'src/', 'bin/', 'test/', 'packages/'], {
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

test('affected selection says explicitly when no claim head was recorded [V4,C7]', async (t) => {
  const box = privateRepo(t);
  seedGraph(box);
  const selection = selectAffectedTests(box.root, { base: null, trunk: 'refs/heads/main' });
  assert.equal(selection.full, true);
  assert.match(selection.reason, /no claim head recorded/u);
});


test('affected selection reads old edges and all changes at the trunk merge base [V4,C7]', async (t) => {
  const box = privateRepo(t);
  const trunk = seedGraph(box);
  box.git('rm', 'src/a.js');
  const claim = commitAll(box, 'refactor(core): remove old source [G1]');
  // A claim made after the deletion and an empty receipt must not hide the trunk-relative change.
  const selection = selectAffectedTests(box.root, { base: claim, trunk, changed: [] });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.files, ['test/a.test.js']);
});


test('affected submit includes branch changes made before the item claim [V4,C7,V16]', async (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
  seedGraph(box);
  put(box.root, 'test/a.test.js', "import assert from 'node:assert/strict'; import { value } from '../src/middle.js'; assert.equal(value, 1);\n");
  box = builderRepo(box);
  put(box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(box, 'feat(core): source before claim [G1]');
  assert.equal((await coordinatorLocal(box, 'add', 'build', 'Existing source change', '--check', 'true')).code, 0);
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);
  put(box.root, 'src/other.js', 'export const other = false;\n');
  commitAll(box, 'feat(core): source after claim [G1]');
  const refused = await runLocal(box, 'submit', '1');
  assert.equal(refused.code, 1, refused.out || refused.err);
  assert.match(refused.err + refused.out, /GATE_RED/u);
  assert.match(refused.err, /affected tests:.*test\/a\.test\.js/u);
  assert.match(refused.err, /ERR_ASSERTION/u);
});


for (const mode of ['deleted source', 'topic parent', 'merge commit']) {
  test(`affected submit on main includes a ${mode} since its claim [V4,C7,V16]`, async (t) => {
    const box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test', lanes: { core: { owns: ['src/', 'test/'], specs: ['G'] } } }));
    seedGraph(box);
    put(box.root, 'test/a.test.js', [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/middle.js';",
      "appendFileSync(process.env.AFFECTED_MARKER, 'ran\\n');",
      'assert.equal(value, 1);',
    ].join('\n'));
    commitAll(box);
    await fileFixtureItem(box, box.root, { lane: 'coordinator', title: 'Main checkout source', check: 'true', run: (cwd, ...args) => runLocal({ ...box, root: cwd }, ...args) });
    const claimed = await runLocal(box, 'claim', '1');
    assert.equal(claimed.code, 0, claimed.err);
    if (mode === 'deleted source') {
      box.git('rm', 'src/a.js');
      commitAll(box, 'refactor(core): delete source on main [G1]');
    } else {
      box.git('checkout', '-q', '-b', 'topic');
      put(box.root, mode === 'topic parent' ? 'src/a.js' : 'src/notes.js', 'export const value = 2;\n');
      commitAll(box, 'feat(core): topic source [G1]');
      box.git('checkout', '-q', 'main');
      if (mode === 'merge commit') {
        put(box.root, 'src/other.js', 'export const other = false;\n');
        commitAll(box, 'feat(core): unrelated main source [G1]');
        box.git('merge', '--no-ff', '--no-commit', 'topic');
        put(box.root, 'src/a.js', 'export const value = 2;\n');
        commitAll(box, 'feat(core): resolve main merge [G1]');
      } else box.git('merge', '--no-ff', '-q', 'topic', '-m', 'feat(core): merge topic into main [G1]');
      assert.equal(box.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
    }
    assert.equal(box.git('branch', '--show-current'), 'main', 'submit runs in the actual main checkout');
    const marker = join(box.dir, 'main-importer-ran.log');
    box.env.AFFECTED_MARKER = marker;
    // Process-level: the unchanged importer runs under its own node --test, not the CLI.
    const standalone = runFixtureChild(process.execPath, ['--test', 'test/a.test.js'], { cwd: box.root, env: box.env, encoding: 'utf8' });
    assert.equal(standalone.status, 1, 'the unchanged importer detects the source regression');
    assert.match(standalone.stdout, mode === 'deleted source' ? /ERR_MODULE_NOT_FOUND/u : /ERR_ASSERTION/u);
    rmSync(marker, { force: true });
    const refused = await runLocal(box, 'submit', '1');
    assert.equal(refused.code, 1, refused.out || refused.err);
    assert.match(refused.err + refused.out, /GATE_RED/u);
    assert.match(refused.err, /affected tests:.*test\/a\.test\.js/u);
    assert.match(refused.err, mode === 'deleted source' ? /ERR_MODULE_NOT_FOUND/u : /ERR_ASSERTION/u);
    if (mode !== 'deleted source') assert.equal(readFileSync(marker, 'utf8'), 'ran\nran\n', 'submit executes the unchanged transitive importer against the candidate and exact main');
  });
}

test('a sandbox-blocked gate asks the person [I1,C7]', async (t) => {
  const command = 'node -e "console.error(process.env.BLOCKED_DIAGNOSTIC); process.exit(Number(process.env.BLOCKED_EXIT || 1))"';
  /** Assert the actual CLI keeps the refused operation and routes the access request through the coordinator. */
  function blocked(result, operation) {
    assert.equal(result.code, 1, result.out + result.err);
    assert.match(result.err, /SANDBOX_BLOCKED/u);
    assert.ok(result.err.includes(operation), result.err);
    assert.match(result.err, /ask the coordinator to bring (?:it|this operation) to the person/iu);
    assert.match(result.err, /pullboard shout coordinator .*--decision/u);
    assert.doesNotMatch(result.err, /\bask the person\b/iu);
    assert.match(result.err, /run the gate outside the sandbox/u);
    assert.match(result.err, /keep the tests unchanged/u);
  }
  await t.test('full gates distinguish listener denial from ordinary failures [I1,C7]', async () => {
    const box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: command }));
    seedGraph(box);
    box.env.BLOCKED_DIAGNOSTIC = 'Error: listen EPERM: operation not permitted 127.0.0.1:0';
    blocked(await runLocal(box, 'gate'), 'listen');
    const log = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-gate.log'));
    assert.match(readFileSync(log, 'utf8'), /Error: listen EPERM/u, 'the original diagnostic is retained');
    assert.ok(existsSync(log + '.profile.json'), 'ordinary timings are retained');
    box.env.BLOCKED_DIAGNOSTIC = 'Error: bind EACCES: permission denied 127.0.0.1:0';
    blocked(await runLocal(box, 'gate'), 'bind');
    for (const diagnostic of [
      'AssertionError [ERR_ASSERTION]: expected EPERM when listen was called',
      'Error: listen EADDRINUSE: address already in use',
      `Error: EACCES: permission denied, open '${join(box.root, 'inside.txt')}'`,
    ]) {
      box.env.BLOCKED_DIAGNOSTIC = diagnostic;
      const ordinary = await runLocal(box, 'gate');
      assert.equal(ordinary.code, 1, ordinary.out + ordinary.err);
      assert.doesNotMatch(ordinary.out + ordinary.err, /SANDBOX_BLOCKED/u);
      assert.match(ordinary.out, /gate red/u);
    }
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node -e "require(\'node:assert/strict\').fail(\'ordinary assertion\')"' }));
    commitAll(box);
    const assertion = await runLocal(box, 'gate');
    assert.equal(assertion.code, 1);
    assert.match(assertion.out, /AssertionError/u);
    assert.doesNotMatch(assertion.out + assertion.err, /SANDBOX_BLOCKED/u);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: command }));
    commitAll(box);
    box.env.BLOCKED_DIAGNOSTIC = 'Error: listen EPERM: operation not permitted';
    box.env.BLOCKED_EXIT = '0';
    const green = await runLocal(box, 'gate');
    assert.equal(green.code, 0, green.err);
    assert.doesNotMatch(green.out + green.err, /SANDBOX_BLOCKED/u, 'a successful diagnostic is not a refusal');
  });
  await t.test('real outside-file TAP denials refuse while permission assertions stay ordinary [I1,C7]', async () => {
    let box = privateRepo(t);
    const runner = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(import.meta.dirname, '../../../../apps/cli/src/io/run/tests.js'))} test/permission.test.js`;
    const directory = join(box.dir, 'readonly-outside-worktree');
    mkdirSync(directory);
    const outside = join(directory, "outside'quote.txt");
    put(box.root, 'pullboard.json', JSON.stringify({ gate: runner }));
    seedGraph(box);
    const operation = `writeFileSync(${JSON.stringify(outside)}, 'blocked')`;
    const prefix = "import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\nimport assert from 'node:assert/strict';\n";
    const denied = prefix + `test('actual outside write', () => ${operation});\n`;
    put(box.root, 'test/permission.test.js', denied);
    commitAll(box);
    box = builderRepo(box);
    chmodSync(directory, 0o500); // The real add baseline must observe the same outside-file refusal.
    assert.equal((await coordinatorLocal(box, 'add', 'build', 'Real permission check', '--check', runner)).code, 0);
    assert.equal((await runLocal(box, 'claim', '1')).code, 0);
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): update selected source [G1]');
    const item = { ...JSON.parse((await coordinatorLocal(box, 'show', '1', '--json')).out), item_commit: box.git('rev-parse', 'HEAD').trim() };
    try {
      assert.throws(() => writeFileSync(outside, 'sentinel'), { code: 'EACCES' }, 'the operating system actually denies this write');
      blocked(await runLocal(box, 'gate'), outside);
      blocked(await runLocal(box, 'check', '1', '--yes'), outside);
      blocked(await runLocal(box, 'submit', '1'), outside);
      const privateResult = checkAtCommit(box.root, item);
      assert.equal(privateResult.state, 'red');
      assert.ok(privateResult.sandboxBlocked?.includes(outside), 'the real private checker scans the TAP record');
      assert.throws(() => refuseSandboxBlocked(privateResult), { code: 'SANDBOX_BLOCKED' });
      const raw = readFileSync(privateResult.outputPath, 'utf8');
      assert.match(raw, /code: 'EACCES'/u);
      assert.ok(raw.includes(outside));
      assert.ok(existsSync(privateResult.profilePath));
      put(box.root, 'test/permission.test.js', prefix + `test('ordinary assertion mentioning permission', () => { try { ${operation}; } catch (error) { assert.fail(error.message); } });\n`);
      commitAll(box);
      const ordinary = await runLocal(box, 'gate');
      assert.equal(ordinary.code, 1);
      assert.match(ordinary.out, /ERR_ASSERTION/u);
      assert.doesNotMatch(ordinary.out + ordinary.err, /SANDBOX_BLOCKED/u);
      const printedDiagnostic = `Error: EACCES: permission denied, open '${outside}'`;
      put(box.root, 'test/permission.test.js', prefix + `test('ordinary assertion prints a permission-looking diagnostic', () => { console.error(${JSON.stringify(printedDiagnostic)}); assert.equal(1, 2); });\n`);
      commitAll(box);
      const printedAssertion = await runLocal(box, 'gate');
      assert.equal(printedAssertion.code, 1);
      assert.doesNotMatch(printedAssertion.out + printedAssertion.err, /SANDBOX_BLOCKED/u);
      assert.match(printedAssertion.out, /ERR_ASSERTION/u);
      assert.match(printedAssertion.out, /# Error: EACCES: permission denied/u, 'TAP retains the test diagnostic as a comment');
      const multilineDiagnostic = `ordinary assertion detail\nError: EACCES: permission denied, open '${outside}'`;
      put(box.root, 'test/permission.test.js', prefix + `test('multiline assertion detail contains a permission-looking line', () => { assert.fail(${JSON.stringify(multilineDiagnostic)}); });\n`);
      commitAll(box);
      const multilineAssertion = await runLocal(box, 'gate');
      assert.equal(multilineAssertion.code, 1);
      assert.doesNotMatch(multilineAssertion.out + multilineAssertion.err, /SANDBOX_BLOCKED/u);
      assert.match(multilineAssertion.out, /ERR_ASSERTION/u);
      assert.match(multilineAssertion.out, /Error: EACCES: permission denied/u);
      put(box.root, 'test/permission.test.js', prefix + `test('ordinary assertion logs a caught OS error', () => { try { ${operation}; } catch (error) { console.error(error); } assert.equal(1, 2); });\n`);
      commitAll(box);
      const caughtAssertion = await runLocal(box, 'gate');
      assert.equal(caughtAssertion.code, 1);
      assert.doesNotMatch(caughtAssertion.out + caughtAssertion.err, /SANDBOX_BLOCKED/u);
      assert.match(caughtAssertion.out, /ERR_ASSERTION/u);
      put(box.root, 'test/permission.test.js', denied);
      commitAll(box);
    } finally { chmodSync(directory, 0o700); }
    const allowed = await runLocal(box, 'gate');
    assert.equal(allowed.code, 0, allowed.out + allowed.err);
    assert.equal(readFileSync(outside, 'utf8'), 'blocked', 'the unchanged real write succeeds when access is restored');
  });
  await t.test('module-startup outside-file denials preserve fatal TAP evidence [I1,C7]', async (t) => {
    const box = privateRepo(t);
    const runner = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(import.meta.dirname, '../../../../apps/cli/src/io/run/tests.js'))} test/permission.test.js`;
    put(box.root, 'pullboard.json', JSON.stringify({ gate: runner }));
    const directory = join(box.dir, 'readonly-module-startup');
    mkdirSync(directory);
    const outside = join(directory, 'outside.txt');
    const testSource = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(outside)}, 'blocked during module evaluation');\n`;
    put(box.root, 'test/permission.test.js', testSource);
    commitAll(box);
    chmodSync(directory, 0o500);
    try {
      assert.throws(() => writeFileSync(outside, 'sentinel'), { code: 'EACCES' }, 'the OS blocks the exact outside path');
      const result = await runLocal(box, 'gate');
      const rawPath = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-gate.log'));
      const innerGateLog = readFileSync(rawPath, 'utf8');
      t.diagnostic(JSON.stringify({ actualPermissionSentinel: 'EACCES', command: 'pullboard gate', code: result.code, stdout: result.out, stderr: result.err, innerGateLog }));
      assert.equal(result.code, 1, result.out + result.err);
      assert.match(result.err, /SANDBOX_BLOCKED/u, 'a real module-startup denial is named for the person');
      assert.ok(result.err.includes(outside), 'the refusal identifies the outside path');
      assert.match(innerGateLog, /# Error: EACCES: permission denied, open /u);
      assert.ok(innerGateLog.includes(`path: '${outside}'`), 'the fatal stack keeps Node’s exact denied path');
      assert.ok(innerGateLog.includes("code: 'ERR_TEST_FAILURE'"), 'Node frames the module-load denial as a test-file failure');
      assert.match(innerGateLog, /failureType: '?testCodeFailure'?(?:\r?\n|$)/u);
      assert.match(innerGateLog, /not ok \d+ - (?:.*\/)?test\/permission\.test\.js/u);
    } finally { chmodSync(directory, 0o700); }
    const allowed = await runLocal(box, 'gate');
    assert.equal(allowed.code, 0, allowed.out + allowed.err);
    assert.equal(readFileSync(outside, 'utf8'), 'blocked during module evaluation');
  });
  await t.test('frozen checks retain outside-file refusal before submit proof [I1,C7]', async () => {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
    seedGraph(box);
    box = builderRepo(box);
    const added = await coordinatorLocal(box, 'add', 'build', 'Sandbox check', '--check', command);
    assert.equal(added.code, 0, added.err);
    assert.equal((await runLocal(box, 'claim', '1')).code, 0);
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): update selected source [G1]');
    const outside = join(box.dir, 'outside.txt');
    box.env.BLOCKED_DIAGNOSTIC = `Error: EACCES: permission denied, open '${outside}'`;
    blocked(await runLocal(box, 'check', '1', '--yes'), 'open');
    blocked(await runLocal(box, 'submit', '1'), 'open');
    const log = resolve(box.root, box.git('rev-parse', '--git-path', 'pullboard-submit.log.check.log'));
    assert.ok(readFileSync(log, 'utf8').includes(outside), 'the exact refused path remains in the raw log');
    box.env.BLOCKED_DIAGNOSTIC = 'AssertionError [ERR_ASSERTION]: ordinary assertion';
    const ordinary = await runLocal(box, 'submit', '1');
    assert.equal(ordinary.code, 1);
    assert.match(ordinary.err, /GATE_RED/u);
    assert.doesNotMatch(ordinary.err, /SANDBOX_BLOCKED/u);
    box.env.BLOCKED_EXIT = '0';
    assert.equal((await runLocal(box, 'submit', '1')).code, 0, 'the unchanged check can pass when the operation is allowed');
    const item = JSON.parse((await coordinatorLocal(box, 'show', '1', '--json')).out);
    /** Run the actual private checker with only these fixture diagnostics in its child environment. */
    function privateCheck(diagnostic) {
      const savedDiagnostic = process.env.BLOCKED_DIAGNOSTIC;
      const savedExit = process.env.BLOCKED_EXIT;
      process.env.BLOCKED_DIAGNOSTIC = diagnostic;
      process.env.BLOCKED_EXIT = '1';
      try { return checkAtCommit(box.root, item); }
      finally {
        if (savedDiagnostic === undefined) delete process.env.BLOCKED_DIAGNOSTIC;
        else process.env.BLOCKED_DIAGNOSTIC = savedDiagnostic;
        if (savedExit === undefined) delete process.env.BLOCKED_EXIT;
        else process.env.BLOCKED_EXIT = savedExit;
      }
    }
    const privateResult = privateCheck('Error: listen EPERM: operation not permitted\n' + 'ordinary trailing output\n'.repeat(80));
    assert.equal(privateResult.state, 'red');
    assert.equal(privateResult.sandboxBlocked, 'listen (EPERM)', 'classification scans before the bounded tail');
    assert.doesNotMatch(privateResult.outputTail, /EPERM/u);
    assert.throws(() => refuseSandboxBlocked(privateResult), { code: 'SANDBOX_BLOCKED' });
    assert.match(readFileSync(privateResult.outputPath, 'utf8'), /Error: listen EPERM/u);
    assert.ok(existsSync(privateResult.profilePath));
    const inside = privateCheck("Error: EACCES: permission denied, open './inside.txt'");
    assert.equal(inside.state, 'red');
    assert.equal(inside.sandboxBlocked, null, 'a private-clone file stays inside that check worktree');
    assert.equal(JSON.parse((await coordinatorLocal(box, 'show', '1', '--json')).out).item_status, 'submitted', 'checks alone record no verdict');
  });
});

test('nested TAP child denials require bounded matching fatal details [C7,B26]', async (t) => {
  const box = privateRepo(t);
  const outside = join(box.dir, 'outside-denied.txt');
  /** Build a failed child TAP record with configurable structured error fields. */
  function tapChildError({ code = 'EACCES', messageCode = 'EACCES', syscall = 'open', path = outside, extra = '' } = {}) {
    return [
      'TAP version 13',
      'not ok 1 - child opens a denied file',
      '  ---',
      "  failureType: 'testCodeFailure'",
      '  error: |-',
      '    App exited before opening the file (code 1, signal null):',
      `    Error: ${messageCode}: permission denied, ${syscall} '${outside}'`,
      '    {',
      `      code: '${code}',`,
      `      syscall: '${syscall}',`,
      `      path: '${path}'`,
      '    }',
      ...extra.split('\n').filter(Boolean).map((line) => `    ${line}`),
      "  code: 'ERR_ASSERTION'",
      '  ...',
    ].join('\n');
  }
  const blocked = sandboxBlockedOperation(box.root, tapChildError());
  assert.equal(blocked, `open "${outside}" (EACCES)`);

  assert.equal(sandboxBlockedOperation(box.root, tapChildError({ code: 'EPERM_FAKE', messageCode: 'EACCES' })), null,
    'the structured code must exactly match the child error');
  assert.equal(sandboxBlockedOperation(box.root, tapChildError({ path: join(box.root, 'inside.txt') })), null,
    'the structured child path must match the resolved denied target');
  assert.equal(sandboxBlockedOperation(box.root, tapChildError({ extra: Array(65).fill('bounded continuation').join('\n') })), null,
    'an oversized error block is not classified');
  assert.equal(sandboxBlockedOperation(box.root, tapChildError(), { includeFilePaths: false }), null,
    'file-path classification remains disabled when requested');

  /** Build stderr-only Node fatal TAP while varying its proof fields. */
  function tapBareNodeError({ code = 'EPERM', syscall = 'listen', version = true, stack = true,
    footer = '1 !== 0', parentCode = 'ERR_ASSERTION', trailing = '', object = true, closeObject = true, exitProse = '' } = {}) {
    return [
      'TAP version 13',
      'not ok 1 - child listens',
      '  ---',
      "  failureType: 'testCodeFailure'",
      '  error: |-',
      ...(exitProse ? [`    ${exitProse}`] : []),
      '    Error: listen EPERM: operation not permitted 127.0.0.1:0',
      ...(stack ? ['        at Server.listen (node:net:2000:7)'] : []),
      ...(object ? ['        {', `          code: '${code}',`, `          syscall: '${syscall}',`,"          address: '127.0.0.1',",'          port: 0', ...(closeObject ? ['        }'] : [])] : []),
      ...(version ? ['    Node.js v22.22.2'] : []),
      ...(trailing ? [`    ${trailing}`] : []),
      '',
      `    ${footer}`,
      `  code: '${parentCode}'`,
      '  ...',
    ].join('\n');
  }
  assert.equal(sandboxBlockedOperation(box.root, tapBareNodeError()), 'listen (EPERM)',
    'bare stderr remains recognizable when the Node fatal fields and assertion prove nonzero exit');
  for (const [label, options] of [
    ['missing stack', { stack: false }],
    ['missing Node version', { version: false }],
    ['missing structured error fields', { object: false }],
    ['truncated structured object', { closeObject: false }],
    ['mismatched structured code', { code: 'EACCES' }],
    ['mismatched structured syscall', { syscall: 'open' }],
    ['non-assertion parent', { parentCode: 'ERR_TEST_FAILURE' }],
    ['zero exit footer', { footer: '0 !== 0' }],
    ['zero child-exit prose cannot fall back to footer', { exitProse: 'App exited before listening (code 0, signal null):' }],
    ['invalid child-exit prose cannot fall back to footer', { exitProse: 'App exited before listening (code unknown, signal null):' }],
    ['unrelated trailing error', { trailing: 'Error: later ordinary failure' }],
  ]) {
    assert.equal(sandboxBlockedOperation(box.root, tapBareNodeError(options)), null, `${label} stays unclassified`);
  }
});

/** Project-declared static guards reject unchanged-gate import regressions before costly proof. */
test('clause 1: a submit runs the static style checks first [C7]', async (t) => {
  // Source under src/, packages/ and apps/ has its multi-binding imports split at commit (776212f0fc), so the violation lives in a .jsx file the splitter skips.
  let box = privateRepo(t);
  const marker = join(box.dir, 'item-check-ran');
  box.env.ITEM_CHECK_MARKER = marker;
  const check = 'node -e "require(\'node:fs\').writeFileSync(process.env.ITEM_CHECK_MARKER, \'ran\')"';
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node -e "process.exit(0)"',
    affectedTests: 'node --test', submitGate: 'landing', staticChecks: 'node test/static-style-check.mjs',
    spec: 'SPEC.md', verify: 'any', lease: '2h', shared: ['pullboard.json'] }));
  put(box.root, 'src/cli.jsx', "import { join } from 'node:path';\nexport const fixture = join;\n");
  const oracle = new URL('../../tests/fixtures/style.js', import.meta.url).href;
  put(box.root, 'test/static-style-check.mjs', [
    "import { readFileSync } from 'node:fs';",
    `import { importStyleViolations } from ${JSON.stringify(oracle)};`,
    "const file = 'src/cli.jsx';",
    "const errors = importStyleViolations([{ file, source: readFileSync(file, 'utf8') }]);",
    "for (const row of errors) console.error(`${row.file}:${row.line}: one import binding per line`);",
    'process.exit(errors.length ? 1 : 0);',
  ].join('\n'));
  commitAll(box);
  box = builderRepo(box);
  const added = await coordinatorLocal(box, 'add', 'build', 'Static style before proof', '--check', check);
  assert.equal(added.code, 0, added.err);
  assert.equal((await runLocal(box, 'claim', '1')).code, 0);
  const candidateConfig = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  candidateConfig.staticChecks = '';
  put(box.root, 'pullboard.json', JSON.stringify(candidateConfig));
  put(box.root, 'src/cli.jsx', "import { join, resolve } from 'node:path';\nexport const fixture = join;\n");
  commitAll(box, 'feat(core): expose the missed static guard [G1]');
  rmSync(marker, { force: true });
  const submitted = await runLocal(box, 'submit', '1', '--json', '--infra', 'the static guard fixture edits its pullboard.json');
  assert.notEqual(submitted.code, 0, 'submit must refuse a static import violation before any item proof');
  assert.match(submitted.out + submitted.err, /src\/cli\.jsx:1: one import binding per line/u);
  assert.equal(existsSync(marker), false, 'the frozen item check must not run after an early static refusal');
  assert.equal(JSON.parse((await runLocal(box, 'show', '1', '--json')).out).item_status, 'claimed');
  const checked = await runLocal(box, 'check', '1', '--yes', '--json');
  assert.notEqual(checked.code, 0, 'an explicit check must run the same accepted project guard first');
  assert.match(checked.out + checked.err, /src\/cli\.jsx:1: one import binding per line/u);
  assert.equal(existsSync(marker), false, 'neither a submit nor a check bypasses the failed static guard');
});

test('clause 1: a red gate queues its flake diagnostics before it asks for a slot, and returns without waiting for one [C7,V4]', async () => {
  const events = [];
  const onFailure = Object.assign(async () => { events.push('observed'); }, { queue: async run => { events.push(`queued ${run.name}`); } });
  // A slot provider that never grants: the diagnostics wait for it, the verdict does not.
  const withSlot = () => { events.push('slot asked'); return new Promise(() => {}); };
  const started = await startDiagnostics('/unused', onFailure, [[{ name: 'red-run' }, { root: '/unused', command: 'true', lease: {} }]], {}, { withSlot });
  assert.deepEqual(events, ['queued red-run', 'slot asked'], 'the job is queued first, then the slot is asked for');
  assert.ok(started.done instanceof Promise, 'the pending diagnostics are handed back, not awaited');
});

test('clause 2: diagnostics run in the granted slot and leave the verdict untouched when the slot fails [C7,V4]', async () => {
  const seen = [];
  const run = { isGreen: false, name: 'red-run' };
  const onFailure = Object.assign(async (observed, context) => { seen.push([observed.name, context.lease.timingOperation]); }, { queue: async () => {} });
  const granted = { proof: null };
  const withSlot = async (_root, work) => { await work(granted); };
  await (await startDiagnostics('/unused', onFailure, [[run, { root: '/unused', command: 'true', lease: { proof: 'p' } }]], {}, { withSlot })).done;
  assert.deepEqual(seen, [['red-run', 'submit']], 'the observer ran once, in the granted slot');
  const failing = async (_root, _work) => { throw Object.assign(new Error('no slot'), { code: 'GATE_INFRA_EXHAUSTED' }); };
  await (await startDiagnostics('/unused', onFailure, [[run, { root: '/unused', command: 'true', lease: {} }]], {}, { withSlot: failing })).done;
  assert.equal(run.isGreen, false, 'a failed diagnostics slot never changes the red verdict');
});
