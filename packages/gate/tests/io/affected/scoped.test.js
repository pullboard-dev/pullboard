/** @pullboard-world-pin: clause 3 reads this repo's own committed tree to count what the scoped walk parses. */
/** @pullboard-test-input source-tree */
/** First-trip result keys parse only what the test and the runner reach, and keep the exact key [C7,#8140]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { temporaryRepository } from '../../../../store/tests/fixtures/submit.js';
import { scopedTestClosures } from '../../../src/io/affected/tests.js';
import { testClosures } from '../../../src/io/affected/tests.js';
import { testActionKeys } from '../../../src/io/test/action/cache.js';
import { TEST_RESULT_STORE_ENV } from '../../../src/io/test/store.js';

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

/** A committed repository: test -> mid -> leaf, plus a module nothing reaches that does not even compile. */
function repository(t) {
  const root = temporaryRepository(t, 'pullboard-scoped-');
  const git = (...args) => runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root });
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  put('package.json', '{"type":"module"}\n');
  put('src/leaf.js', 'export const leaf = 1;\n');
  put('src/mid.js', "export { leaf } from './leaf.js';\n");
  put('src/island.js', 'export const island = ;\n');
  put('test/chain.test.js', "import '../src/mid.js';\n");
  git('add', '-A'); git('commit', '-qm', 'chore: fixture');
  return { root, put, commit: () => { git('add', '-A'); git('commit', '-qm', 'change'); } };
}

/** The input key of the chain test, in a store and home private to this call. */
async function chainKey(t, root) {
  const home = privateFixtureFiles('pullboard-scoped-home-').root;
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: join(home, 'm'), PULLBOARD_ACCOUNT_HOME: join(home, 'a'), [TEST_RESULT_STORE_ENV]: join(home, 'store') };
  const keys = await testActionKeys(root, { env, files: ['test/chain.test.js'], maintain: false });
  return keys.get('test/chain.test.js').inputKey;
}

test('clause 1: the scoped walk closes the test through what it reaches and never reads a module outside that reach [C7,#8140]', t => {
  const { root } = repository(t);
  assert.throws(() => testClosures(root, 'HEAD'), 'the whole-tree graph reads the unreachable file and fails on it');
  const probe = {};
  const scoped = scopedTestClosures(root, 'HEAD', ['test/chain.test.js'], [], probe);
  assert.deepEqual(scoped.closures.get('test/chain.test.js').files, ['src/leaf.js', 'src/mid.js', 'test/chain.test.js']);
  assert.deepEqual([...probe.parsed].sort(), ['src/leaf.js', 'src/mid.js', 'test/chain.test.js']);
});

test('clause 2: a change to a reached module changes the result key, and a change to an unreached one does not [C7,#8140]', async t => {
  const box = repository(t);
  const before = await chainKey(t, box.root);
  box.put('src/island.js', 'export const island = 2;\n'); box.commit();
  assert.equal(await chainKey(t, box.root), before, 'an unreachable module leaves the key alone');
  box.put('src/leaf.js', 'export const leaf = 2;\n'); box.commit();
  assert.notEqual(await chainKey(t, box.root), before, 'a reachable module changes the key');
});

test('clause 3: on this tree the scoped walk parses neither the unrelated tests nor most of the tree [C7,#8140]', () => {
  const file = 'packages/gate/tests/io/affected/keyless.test.js';
  const probe = {};
  const scoped = scopedTestClosures(ROOT, 'HEAD', [file], ['apps/cli/src/io/run/tests.js', 'packages/gate/src/io/run-tests.js'], probe);
  assert.ok(scoped.closures.get(file).files, 'the closure is complete');
  const tests = probe.parsed.filter(path => /\.test\.js$/u.test(path));
  assert.ok(tests.length <= 5, `only tests the walk reaches are parsed, saw ${tests.length}`);
  assert.ok(!probe.parsed.includes('packages/gate/tests/io/affected/tests.test.js'), 'an unrelated test file is never parsed');
});
