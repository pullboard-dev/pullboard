/** @pullboard-test-input source-tree */
/**
 * Submit without a frozen check, a red frozen check, CommonJS fallbacks and source changes carried by topic parents and merges: one slice of the submit gate proof, split from gate.test.js to stay under the runner time budget; the topic-parent and merge-commit cases live in carried/topic.test.js [V4,C7,V16].
 */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
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
  submitSettled,
} from './local.js';
import {
  privateRepo,
  builderRepo,
  put,
  commitAll,
  seedGraph,
} from '../../../tests/fixtures/submit/gate.js';
import {
  describe,
  test,
} from 'node:test';

describe('submit gate cases that need no shared state run together [V4,C7,V16]', { concurrency: true }, () => {
  test('submit without a frozen check reports no item check and still runs affected tests [V4,C7,V16]', async (t) => {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
    put(box.root, 'src/a.js', 'export const value = 1;\n');
    // The pulled gate runs in the runner's checkout without this test's environment, so the marker path is written into the test.
    const marker = join(box.dir, 'without-check.log');
    put(box.root, 'test/a.test.js', `import '../src/a.js'; import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    put(box.root, 'test/b.test.js', "import assert from 'node:assert/strict'; assert.fail('unrelated');\n");
    commitAll(box, 'chore: fixture state', true);
    box = builderRepo(box, [], { plumbing: true });
    assert.equal((await coordinatorLocal(box, 'add', 'build', 'No frozen command')).code, 0);
    assert.equal((await runLocal(box, 'claim', '1')).code, 0);
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): update selected source [G1]');
    const result = await submitSettled(t, box, (...args) => runLocal(box, ...args));
    assert.equal(result.code, 0, result.err);
    const receipt = result.receipt;
    // The pulled report names the selection; the absent check is the receipt's own checked flag.
    assert.match(receipt.gate.report, /affected tests: test\/a\.test\.js/u);
    assert.equal(receipt.gate.check.checked, false);
    assert.equal(receipt.gate.full, false);
    assert.deepEqual(receipt.gate.files, ['test/a.test.js']);
    assert.ok(existsSync(marker), 'the affected test ran without an item check');
    assert.equal(readFileSync(marker, 'utf8'), 'ran');
  });

  test('a red frozen item check refuses submit before affected tests run [V4,C7,V16]', async (t) => {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
    seedGraph(box, true);
    box = builderRepo(box, [], { plumbing: true });
    // The pulled gate runs the frozen check without this test's environment, so the refusal is a file the check looks for.
    const refusal = join(box.dir, 'check-refuse');
    const added = await coordinatorLocal(box, 'add', 'build', 'Frozen check', '--check', `node -e "process.exit(require('fs').existsSync(${JSON.stringify(refusal)}) ? 1 : 0)"`);
    assert.equal(added.code, 0, added.err);
    assert.equal((await runLocal(box, 'claim', '1')).code, 0);
    put(box.root, 'src/a.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): update selected source [G1]');
    writeFileSync(refusal, 'refuse\n');
    const refused = await submitSettled(t, box, (...args) => runLocal(box, ...args));
    assert.equal(refused.code, 1, refused.out);
    assert.equal(refused.receipt.gate.green, false, 'the pulled gate came back red');
    assert.match(refused.err, /check exited 1/u, 'the red is the frozen item check');
    // The pulled gate starts the check and the proof together, so the red check is the refusal's cause, not proof that nothing else ran.
    assert.equal(refused.receipt.gate.check.checked, true);
    assert.equal(refused.receipt.gate.check.green, false, 'the frozen item check is the red one');
  });


  test('CommonJS and nested package scopes fall back instead of silently missing require edges [V4,V16]', async (t) => {
    const common = privateRepo(t);
    put(common.root, 'package.json', '{"type":"commonjs"}\n');
    put(common.root, 'src/a.js', 'module.exports = 1;\n');
    put(common.root, 'test/a.test.js', "require('../src/a.js');\n");
    put(common.root, 'test/b.test.js', "require('node:assert/strict').ok(true);\n");
    const base = commitAll(common, 'chore: fixture state', true);
    put(common.root, 'src/a.js', 'module.exports = 2;\n');
    const commit = commitAll(common, 'feat(core): change CommonJS source [G1]', true);
    const selection = selectAffectedTests(common.root, { base, commit });
    assert.equal(selection.full, true, 'require import edges cannot be silently omitted');
    assert.match(selection.reason, /does not declare "type": "module"|package scope/u);

    const nested = privateRepo(t);
    seedGraph(nested, true);
    put(nested.root, 'legacy/package.json', '{"type":"commonjs"}\n');
    put(nested.root, 'legacy/value.js', 'module.exports = 1;\n');
    const nestedBase = commitAll(nested, 'chore: fixture state', true);
    put(nested.root, 'legacy/value.js', 'module.exports = 2;\n');
    const nestedCommit = commitAll(nested, 'feat(core): change nested CommonJS source [G1]', true);
    const scoped = selectAffectedTests(nested.root, { base: nestedBase, commit: nestedCommit });
    assert.equal(scoped.full, true, 'nested package policy makes a single ESM graph incomplete');
    assert.match(scoped.reason, /package scope/u);

    const esm = privateRepo(t);
    const esmBase = seedGraph(esm, true);
    put(esm.root, 'src/a.js', "import { createRequire } from 'node:module'; export const load = createRequire(import.meta.url);\n");
    const esmCommit = commitAll(esm, 'feat(core): create a CommonJS loader [G1]', true);
    const loader = selectAffectedTests(esm.root, { base: esmBase, commit: esmCommit });
    // 17f76d43ff (#3170): a reached file with unknown reads selects its importers, not the whole suite.
    assert.equal(loader.full, false, 'a reached CommonJS loader selects its importers, not the whole suite');
    assert.ok(loader.files.includes('test/a.test.js'), 'the importer chain test/a.test.js -> entry -> middle -> the loader is selected');
    assert.ok(!loader.files.includes('test/b.test.js') && !loader.files.includes('test/c.test.js'), 'tests that never reach the loader stay out');
  });
});
