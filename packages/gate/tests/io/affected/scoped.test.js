/** First-trip result keys parse only what the test and the runner reach, and keep the exact key [C7,#8140]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { temporaryRepository } from '../../../../store/tests/fixtures/submit.js';
import { scopedTestClosures } from '../../../src/io/affected/tests.js';
import { testClosures } from '../../../src/io/affected/tests.js';
import { testActionKeys } from '../../../src/io/test/action/cache.js';
import { TEST_RESULT_STORE_ENV } from '../../../src/io/test/store.js';

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

test('gate.io-affected-scoped.the-scoped-walk-closes-the-test: clause 1: the scoped walk closes the test through what it reaches and never reads a module outside that reach [C7,#8140]', t => {
  const { root } = repository(t);
  assert.throws(() => testClosures(root, 'HEAD'), 'the whole-tree graph reads the unreachable file and fails on it');
  const probe = {};
  const scoped = scopedTestClosures(root, 'HEAD', ['test/chain.test.js'], [], probe);
  assert.deepEqual(scoped.closures.get('test/chain.test.js').files, ['src/leaf.js', 'src/mid.js', 'test/chain.test.js']);
  assert.deepEqual([...probe.parsed].sort(), ['src/leaf.js', 'src/mid.js', 'test/chain.test.js']);
});

test('gate.io-affected-scoped.a-change-to-a-reached-module: clause 2: a change to a reached module changes the result key, and a change to an unreached one does not [C7,#8140]', async t => {
  const box = repository(t);
  const before = await chainKey(t, box.root);
  box.put('src/island.js', 'export const island = 2;\n'); box.commit();
  assert.equal(await chainKey(t, box.root), before, 'an unreachable module leaves the key alone');
  box.put('src/leaf.js', 'export const leaf = 2;\n'); box.commit();
  assert.notEqual(await chainKey(t, box.root), before, 'a reachable module changes the key');
});

test('gate.io-affected-scoped.the-walk-parses-the-runner-entry: clause 3: the walk parses the runner entry and its reach, and no unrelated test or module [C7,#8140]', t => {
  const box = repository(t);
  box.put('src/run.js', "import './harness.js';\n");
  box.put('src/harness.js', 'export const harness = 1;\n');
  for (let at = 0; at < 30; at += 1) box.put(`src/other${at}.js`, `export const other = ${at};\n`);
  box.put('test/other.test.js', "import '../src/other0.js';\n");
  box.commit();
  const probe = {};
  const scoped = scopedTestClosures(box.root, 'HEAD', ['test/chain.test.js'], ['src/run.js'], probe);
  assert.deepEqual(scoped.reach(['src/run.js']), ['src/harness.js', 'src/run.js']);
  assert.deepEqual([...probe.parsed].sort(), ['src/harness.js', 'src/leaf.js', 'src/mid.js', 'src/run.js', 'test/chain.test.js']);
});

test('gate.io-affected-scoped.a-first-trip-reads-reached-modules: clause 1: a first trip reads reached modules from the clean checkout, and a changed file is read from its commit [C7,#8135]', t => {
  const box = repository(t);
  const clean = scopedTestClosures(box.root, 'HEAD', ['test/chain.test.js'], []);
  assert.deepEqual(clean.closures.get('test/chain.test.js').files, ['src/leaf.js', 'src/mid.js', 'test/chain.test.js']);
  // An uncommitted edit to a reached module: the file's bytes no longer hash to the committed object, so Git's bytes decide.
  box.put('src/mid.js', "import './island.js';\nexport { leaf } from './leaf.js';\n");
  const dirty = scopedTestClosures(box.root, 'HEAD', ['test/chain.test.js'], []);
  assert.deepEqual(dirty.closures.get('test/chain.test.js').files, ['src/leaf.js', 'src/mid.js', 'test/chain.test.js'], 'the committed import list is used, not the edited file');
  assert.equal(dirty.modules.get('src/mid.js'), "export { leaf } from './leaf.js';\n");
});

test('gate.io-affected-scoped.measurement-the-first-test-result-preparation: clause 2: measurement: the first test-result preparation of this one-file test on the real tree prints its milliseconds [C7,#8140]', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const home = privateFixtureFiles('pullboard-scoped-first-').root;
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, PULLBOARD_MACHINE_HOME: join(home, 'm'), PULLBOARD_ACCOUNT_HOME: join(home, 'a'), [TEST_RESULT_STORE_ENV]: join(home, 'store') };
  const file = 'packages/gate/tests/io/affected/scoped.test.js';
  const started = performance.now();
  const keys = await testActionKeys(root, { env, files: [file], maintain: false });
  const ms = Math.round(performance.now() - started);
  assert.ok(keys.get(file)?.inputKey, 'the one test got a result key');
  // The 1 s bar is read from this line in the runner's log, never asserted: a loaded runner would make a wall-clock assertion flake [#8751].
  console.log(`# first-preparation-ms ${ms} ${file}`);
});
