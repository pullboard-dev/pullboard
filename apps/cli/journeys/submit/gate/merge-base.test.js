/** @pullboard-test-input source-tree */
/**
 * Claim-head reads, trunk merge-base reads and branch changes made before the claim: one slice of the submit gate proof, split from gate.test.js to stay under the runner time budget [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import {
  runFixtureChild,
} from '../../../tests/fixtures/child.js';
import {
  appendFileSync,
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
  fileFixtureItem,
} from '../../../tests/fixtures/testkit.js';
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
