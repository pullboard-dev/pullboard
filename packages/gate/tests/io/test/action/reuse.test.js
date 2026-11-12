/** A test file's key follows only its import closure and declared inputs across commits, so a green is reused exactly then [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { testActionKeys } from '../../../../src/io/test/action/cache.js';
import { fixtureCommittedGraph } from '../../../../../../apps/cli/tests/fixtures/testkit.js';

const PLAIN = 'packages/demo/tests/plain.test.js';
const OTHER = 'packages/demo/tests/other.test.js';
const WIDE = 'packages/demo/tests/wide.test.js';
/** A fixture repository with a plain test, another test on its own module, and a source-tree test. */
function fixture() {
  const repo = fixtureCommittedGraph('pullboard-reuse-keys-');
  repo.put('package.json', '{"name":"demo","type":"module"}\n');
  repo.put('packages/demo/src/used.js', 'export const used = 1;\n');
  repo.put('packages/demo/src/free.js', 'export const free = 1;\n');
  repo.put('packages/demo/src/unrelated.js', 'export const unrelated = 1;\n');
  repo.put(PLAIN, "import { used } from '../src/used.js';\nexport { used };\n");
  repo.put(OTHER, "import { free } from '../src/free.js';\nexport { free };\n");
  repo.put(WIDE, "/** @pullboard-test-input source-tree */\nimport { used } from '../src/used.js';\nexport { used };\n");
  return { root: repo.root, put: repo.put, commit: repo.commit, done: () => rmSync(repo.root, { recursive: true, force: true }) };
}

/** The input keys of the three fixture tests at a commit. */
async function keysAt(fx, commit) {
  const env = { ...process.env, PULLBOARD_TEST_RESULT_STORE: fx.root + '/.store' };
  const keys = await testActionKeys(fx.root, { commit, env, maintain: false, files: [PLAIN, OTHER, WIDE] });
  return Object.fromEntries([PLAIN, OTHER, WIDE].map(file => [file, keys.get(file)?.inputKey]));
}

test('clause 1: a test keeps its key across commits that leave its import closure alone, and changes it when a closure file changes [C7]', async () => {
  const fx = fixture();
  try {
    const a = fx.commit();
    fx.put('packages/demo/src/free.js', 'export const free = 2;\n');
    const b = fx.commit();
    const [before, after] = [await keysAt(fx, a), await keysAt(fx, b)];
    assert.ok(before[PLAIN] && before[OTHER], 'both closures are complete, so both have keys');
    assert.equal(after[PLAIN], before[PLAIN], 'its closure is unchanged: the green carries over');
    assert.notEqual(after[OTHER], before[OTHER], 'a closure file changed: the file reruns');
  } finally { fx.done(); }
});

test('clause 2: a source-tree test changes its key on any source change, even outside its imports [C7]', async () => {
  const fx = fixture();
  try {
    const a = fx.commit();
    fx.put('packages/demo/src/unrelated.js', 'export const unrelated = 2;\n');
    const b = fx.commit();
    const [before, after] = [await keysAt(fx, a), await keysAt(fx, b)];
    assert.ok(before[WIDE], 'the source-tree test has a key');
    assert.notEqual(after[WIDE], before[WIDE], 'a source change anywhere reruns it');
    assert.equal(after[PLAIN], before[PLAIN], 'a test without the declaration is unaffected by that file');
  } finally { fx.done(); }
});
