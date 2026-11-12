/** @pullboard-test-input source-tree */
/**
 * Submit without a frozen check, a red frozen check, CommonJS fallbacks and source changes carried by topic parents and merges: one slice of the submit gate proof, split from gate.test.js to stay under the runner time budget [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import {
  runFixtureChild,
} from '../../../tests/fixtures/child.js';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  selectAffectedTests,
} from '../../../../../packages/gate/index.js';
import {
  coordinatorLocal,
  runLocal,
} from './local.js';
import {
  privateRepo,
  builderRepo,
  put,
  commitAll,
  seedGraph,
} from '../../../tests/fixtures/submit/gate.js';
import {
  test,
} from 'node:test';

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
