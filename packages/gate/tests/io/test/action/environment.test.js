/** A test file's result key covers the environment it reads: declared names and every non-harness PULLBOARD_* variable [#4380]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { testActionKeys } from '../../../../src/io/test/action/cache.js';
import { fixtureCommittedGraph } from '../../../fixtures/testkit.js';

const PLAIN = 'packages/demo/tests/plain.test.js';
const DECLARING = 'packages/demo/tests/declaring.test.js';
/** A fixture repository with a plain test and one that declares TRAIN_RED as an input. */
function fixture() {
  const repo = fixtureCommittedGraph('pullboard-env-keys-');
  repo.put('package.json', '{"name":"demo","type":"module"}\n');
  repo.put('packages/demo/src/used.js', 'export const used = 1;\n');
  repo.put(PLAIN, "import { used } from '../src/used.js';\nexport { used };\n");
  repo.put(DECLARING, "/** @pullboard-test-env TRAIN_RED */\nimport { used } from '../src/used.js';\nexport { used };\n");
  return { root: repo.root, commit: repo.commit(), done: () => rmSync(repo.root, { recursive: true, force: true }) };
}

/** The full keys of both fixture tests under an environment layered on a clean base. */
async function keysUnder(fx, extra = {}) {
  const env = { PATH: process.env.PATH, PULLBOARD_TEST_RESULT_STORE: fx.root + '/.store', ...extra };
  const keys = await testActionKeys(fx.root, { commit: fx.commit, env, maintain: false, files: [PLAIN, DECLARING] });
  return { plain: keys.get(PLAIN)?.key, declaring: keys.get(DECLARING)?.key };
}

test('#4380 clause 1: a declared environment variable keys the file that declares it and no other [C7]', async () => {
  const fx = fixture();
  try {
    const [none, red, green] = [await keysUnder(fx), await keysUnder(fx, { TRAIN_RED: '1' }), await keysUnder(fx, { TRAIN_RED: '0' })];
    assert.ok(none.declaring && none.plain, 'both files have keys');
    assert.notEqual(red.declaring, none.declaring, 'a set value is a different key than an unset one');
    assert.notEqual(red.declaring, green.declaring, 'two values are two keys');
    assert.equal(red.plain, none.plain, 'a file that declares nothing ignores it');
  } finally { fx.done(); }
});

test('#4380 clause 2: a PULLBOARD_* variable outside the harness set changes every key; a harness one does not [C7]', async () => {
  const fx = fixture();
  try {
    const [none, loose, other, harness] = [await keysUnder(fx), await keysUnder(fx, { PULLBOARD_FIXTURE_FLAG: 'a' }), await keysUnder(fx, { PULLBOARD_FIXTURE_FLAG: 'b' }), await keysUnder(fx, { PULLBOARD_RUN_SHIM_PID: '42', PULLBOARD_TEST_PROGRESS: '1' })];
    assert.notEqual(loose.plain, none.plain);
    assert.notEqual(loose.plain, other.plain);
    assert.deepEqual(harness, none, 'harness variables stay per-run noise');
  } finally { fx.done(); }
});

test('#4380 clause 3: identical declared environment still reuses the same key [C7]', async () => {
  const fx = fixture();
  try {
    const env = { TRAIN_RED: '1', PULLBOARD_FIXTURE_FLAG: 'a' };
    assert.deepEqual(await keysUnder(fx, env), await keysUnder(fx, { ...env }));
  } finally { fx.done(); }
});

test('#7639 clause 1: per-job harness paths and gate slot variables do not change the key, so two workers on one tree share it [C7]', async () => {
  const fx = fixture();
  try {
    const base = await keysUnder(fx);
    const perJob = [
      ['PULLBOARD_BROWSER_REFUSAL_FILE', '/tmp/job-a/refusal.json', '/tmp/job-b/refusal.json'],
      ['PULLBOARD_GATE_SLOT_HELD', 'lease-a', 'lease-b'],
      ['PULLBOARD_GATE_SLOT_POOL', '/tmp/pool-a', '/tmp/pool-b'],
      ['PULLBOARD_GATE_SLOT_TOKEN', 'token-a', 'token-b'],
      ['PULLBOARD_BROWSER_SLOT_HELD', '1', '2'],
      ['PULLBOARD_RUNTIME_CAPTURE_DIR', '/tmp/capture-a', '/tmp/capture-b'],
    ];
    for (const [name, first, second] of perJob) {
      const [one, two] = [await keysUnder(fx, { [name]: first }), await keysUnder(fx, { [name]: second })];
      assert.deepEqual(one, two, `${name} differs per job and must not key a result`);
      assert.deepEqual(one, base, `${name} set must key the same as unset`);
    }
  } finally { fx.done(); }
});

test('#7822 clause 1: a land proof keys a gate-proved file as its gate shard did, whatever the pulled job variables differ in [C7]', async () => {
  const fx = fixture();
  try {
    // A gate shard's job carries its worker count and the trunk remote; its land job's proof carries neither (packages/drive pull.js).
    const gate = { TZ: 'UTC', LANG: 'C.UTF-8', PULLBOARD_JOB_WORKERS: '2', PULLBOARD_TRUNK_REMOTE: 'coreyolson@100.109.124.33:pb-trunk', PULLBOARD_RUNNER_TOOLS: '/runner/a' };
    const land = { TZ: 'UTC', LANG: 'C.UTF-8', PULLBOARD_RUNNER_TOOLS: '/runner/b' };
    const [proved, landing, otherGate] = [await keysUnder(fx, gate), await keysUnder(fx, land), await keysUnder(fx, { ...gate, PULLBOARD_JOB_WORKERS: '5', PULLBOARD_TRUNK_REMOTE: '/other/trunk' })];
    assert.ok(proved.plain && proved.declaring, 'the gate env keys both files');
    assert.deepEqual(landing, proved, 'the land env reuses the gate receipt key');
    assert.deepEqual(otherGate, proved, 'a different worker count or trunk remote keys the same');
  } finally { fx.done(); }
});
