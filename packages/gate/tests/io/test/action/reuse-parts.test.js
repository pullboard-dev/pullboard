/** Fleet reuse parts proved on the cell's own functions, with no runner trip: closure, harness and red [C7,V4]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { planTestActions } from '../../../../src/io/test/action/cache.js';
import { reusableResult } from '../../../../src/io/test/action/cache.js';
import { testActionKeys } from '../../../../src/io/test/action/cache.js';
import { importTestResults } from '../../../../src/io/test/store.js';
import { packTestResults } from '../../../../src/io/test/store.js';
import { completedTestResult } from '../../../../src/io/test/store.js';
import { selectedTestResults } from '../../../../src/io/test/store.js';
import { storeTestResult } from '../../../../src/io/test/store.js';
import { testResultDigest } from '../../../../src/io/test/store.js';
import { fixtureCommittedGraph } from '../../../fixtures/testkit.js';

const PROBE = 'test/probe.test.js';
const STABLE = 'test/stable.test.js';
const REPORTER = 'packages/gate/src/io/test/action/reporter.js';

/** A repository with a probe reaching lib/value.js, a stable companion reaching lib/stable.js, and the harness reporter. */
function fixture() {
  const repo = fixtureCommittedGraph('pullboard-reuse-parts-');
  repo.put('package.json', '{"name":"demo","type":"module"}\n');
  repo.put('lib/value.js', 'export const value = 1;\n');
  repo.put('lib/stable.js', 'export const stable = 1;\n');
  repo.put(PROBE, "import { value } from '../lib/value.js';\nexport { value };\n");
  repo.put(STABLE, "import { stable } from '../lib/stable.js';\nexport { stable };\n");
  repo.put(REPORTER, 'export const reporter = 1;\n');
  return { root: repo.root, put: repo.put, commit: repo.commit, done: () => rmSync(repo.root, { recursive: true, force: true }) };
}

/** Both files' keys at a commit, against a store under the fixture. */
async function keysAt(fx, commit) {
  const env = { ...process.env, PULLBOARD_TEST_RESULT_STORE: fx.root + '/.store' };
  return testActionKeys(fx.root, { commit, env, maintain: false, files: [PROBE, STABLE] });
}

/** A complete stored receipt for a key, as a worker's completed run records it. */
function receipt(file, { inputKey, key, context }, status, request) {
  const commit = 'a'.repeat(40);
  const at = '2026-11-15T12:00:00.000Z';
  const base = { version: 2, inputKey, key, context, file, commit, stage: 'submit', at, status,
    origin: { machine: 'machine-a', stage: 'submit', commit, at, request } };
  if (status === 'fail') return base;
  return { ...base, tap: { lines: ['ok 1 - probe'], counts: { passed: 1, failed: 0, skipped: 0, tests: 1 }, observedTests: 1 } };
}

test('gate.io-test-action-reuse-parts.clause-3-closure-editing-a-reached: clause 3 closure: editing a reached module re-keys only its file, and the stored companion receipt is still selected [C7,V4]', async () => {
  const fx = fixture();
  try {
    const before = await keysAt(fx, fx.commit());
    const store = fx.root + '/.store';
    const request = '11111111-1111-4111-8111-111111111111';
    assert.equal(storeTestResult(store, receipt(STABLE, before.get(STABLE), 'pass', request)), true);
    fx.put('lib/value.js', 'export const value = 2;\n');
    const after = await keysAt(fx, fx.commit());
    assert.notEqual(after.get(PROBE).inputKey, before.get(PROBE).inputKey, 'the edited closure reruns its file');
    assert.equal(after.get(STABLE).inputKey, before.get(STABLE).inputKey, 'the unchanged companion keeps its input identity');
    const rows = selectedTestResults(store, [after.get(STABLE).inputKey]);
    assert.deepEqual(rows.map(row => row.file), [STABLE], 'the companion receipt is selected for the new tree');
    assert.deepEqual(selectedTestResults(store, [after.get(PROBE).inputKey]), [], 'the edited file has nothing to reuse');
  } finally { fx.done(); }
});

test('gate.io-test-action-reuse-parts.clause-3-harness-changed-harness-bytes: clause 3 harness: changed harness bytes re-key every file, and a caller-selected reporter keeps every file running [C7,V4]', async () => {
  const fx = fixture();
  try {
    const before = await keysAt(fx, fx.commit());
    fx.put(REPORTER, 'export const reporter = 2;\n');
    const after = await keysAt(fx, fx.commit());
    for (const file of [PROBE, STABLE]) assert.notEqual(after.get(file).inputKey, before.get(file).inputKey, `${file} follows the harness bytes`);
    const out = [];
    const plan = await planTestActions(fx.root, [PROBE, STABLE, '--test-reporter=./reporter.mjs'], {
      fullSuite: false, listFiles: () => [PROBE, STABLE], env: { ...process.env, PULLBOARD_TEST_RESULT_STORE: fx.root + '/.store' }, write: text => out.push(text) });
    assert.equal(plan.done, false, 'a reporter-selecting caller never takes the reuse shortcut');
    assert.match(plan.args.join(' '), /probe\.test\.js.*stable\.test\.js|stable\.test\.js.*probe\.test\.js/u, 'both files still run');
  } finally { fx.done(); }
});

test('gate.io-test-action-reuse-parts.clause-3-red-a-red-receipt: clause 3 red: a red receipt wins over a green, is never reusable, and a worker request alone is not completed proof [C7,V4]', async () => {
  const fx = fixture();
  try {
    const keys = await keysAt(fx, fx.commit());
    const store = fx.root + '/.store';
    const request = '11111111-1111-4111-8111-111111111111';
    const pass = receipt(PROBE, keys.get(PROBE), 'pass', request);
    assert.equal(storeTestResult(store, pass), true);
    assert.equal(reusableResult(store, pass.key)?.status, 'pass', 'a green is reusable until a red exists');
    assert.equal(storeTestResult(store, receipt(PROBE, keys.get(PROBE), 'fail', request)), true);
    assert.equal(reusableResult(store, pass.key), null, 'a red mark ends reuse of the key');
    assert.equal(storeTestResult(store, pass), false, 'a later green for a red key is refused');
    const rows = selectedTestResults(store, [pass.inputKey]);
    assert.deepEqual(rows.map(row => row.status), ['fail'], 'selection serves the red, never the green');
    assert.ok(!completedTestResult(pass), 'a pending request is not completed proof');
    const completion = { id: request, commit: pass.commit, tree: 'b'.repeat(40), code: 0, signal: null,
      outputSha256: 'c'.repeat(64), runtimeSha256: 'd'.repeat(64), toolingSha256: 'e'.repeat(64) };
    assert.ok(completedTestResult({ ...pass, origin: { ...pass.origin, completion } }));
    assert.equal(testResultDigest({ inputKey: pass.inputKey, context: pass.context }), pass.key, 'the receipt key is the input key under its context');
  } finally { fx.done(); }
});

test('gate.io-test-action-reuse-parts.clause-3-environment-a-material-language: clause 3 environment: a material language change re-keys a file under the same input key, so another environment never reuses a green [C7,V4]', async () => {
  const fx = fixture();
  try {
    const commit = fx.commit();
    const keysWith = async LANG => testActionKeys(fx.root, { commit, env: { PATH: process.env.PATH, LANG, PULLBOARD_TEST_RESULT_STORE: fx.root + '/.store' }, maintain: false, files: [PROBE] });
    const [plain, other] = [await keysWith('C.UTF-8'), await keysWith('cache-material-language')];
    assert.equal(other.get(PROBE).inputKey, plain.get(PROBE).inputKey, 'the files are the same');
    assert.notEqual(other.get(PROBE).key, plain.get(PROBE).key, 'the environment is part of the result key');
  } finally { fx.done(); }
});

test('gate.io-test-action-reuse-parts.clause-1-transfer-a-packed-result: clause 1 transfer: a packed result imports into a second store for the requested keys only, with no fleet trip [C7,V4]', async () => {
  const fx = fixture();
  try {
    const keys = await keysAt(fx, fx.commit());
    const request = '11111111-1111-4111-8111-111111111111';
    const storeA = fx.root + '/.store-a';
    const storeB = fx.root + '/.store-b';
    for (const file of [PROBE, STABLE]) assert.equal(storeTestResult(storeA, receipt(file, keys.get(file), 'pass', request)), true);
    const packet = packTestResults(selectedTestResults(storeA, [keys.get(PROBE).inputKey, keys.get(STABLE).inputKey]));
    assert.equal(typeof packet, 'string', 'the records pack for transfer');
    assert.equal(importTestResults(storeB, packet, [keys.get(STABLE).inputKey]), 1, 'only the requested key is imported');
    assert.deepEqual(selectedTestResults(storeB, [keys.get(PROBE).inputKey]), [], 'an unrequested key carries nothing');
    const carried = selectedTestResults(storeB, [keys.get(STABLE).inputKey]);
    assert.deepEqual(carried.map(row => row.file), [STABLE]);
    assert.equal(carried[0].status, 'pass');
    assert.equal(importTestResults(storeB, 'not-a-packet', [keys.get(STABLE).inputKey]), 0, 'an invalid packet confers nothing');
  } finally { fx.done(); }
});
