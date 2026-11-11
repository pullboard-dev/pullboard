/** Before queueing, a test file whose inputs match a runner-completed green is dropped and named; anything else runs [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import {
  RECORD_ONLY_PREFIX,
  planTestActions,
  preQueueReuse,
  prepareTestResultExchange,
  reuseReceipt,
  testActionKeys,
} from '../../../../packages/gate/index.js';
import {
  storeTestResult,
  testResultDigest,
} from '../../../../packages/gate/src/io/test/store.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FILE = 'packages/gate/tests/io/test/action/cache.test.js';
const OTHER = 'packages/gate/tests/io/test/action/memo.test.js';
const TOOLING = 'c'.repeat(64);
const HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const TREE = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
// The runner's context: declared environment unset except TZ=UTC, LANG=C and the tooling sha.
const ENVIRONMENT = ['NODE_OPTIONS', 'PULLBOARD_HOSTED_SHAPES', 'PULLBOARD_TEST_TIMEOUT_MS', 'PULLBOARD_TEST_FILE_TIMEOUT_MS', 'PULLBOARD_TEST_REAL',
  'PULLBOARD_ADAPTER_AUDIT', 'TZ', 'LANG', 'LC_ALL', 'PULLBOARD_TEST_CACHE_TOOLING'].map(name => [name,
  { TZ: 'UTC', LANG: 'C', PULLBOARD_TEST_CACHE_TOOLING: TOOLING }[name] ?? null]);

/** A scratch result store, so the machine's own store is neither read nor written. */
function scratchEnv() {
  const store = privateFixtureFiles('pullboard-selection-').root;
  // Drop what a runner job sets for its own run (action dir, result exchange, reuse mode), or the planner refuses to consult a green.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PULLBOARD_TEST_(ACTIONS|STAGE|REUSE|RESULT_\w+)$/u.test(name)));
  return { store, env: { ...env, PULLBOARD_TEST_RESULT_STORE: store }, done: () => rmSync(store, { recursive: true, force: true }) };
}

/** The input key a file has at HEAD. */
async function inputKeyOf(env, file) {
  return (await testActionKeys(ROOT, { commit: HEAD, files: [file], env, maintain: false })).get(file).inputKey;
}

/** Record a runner-completed green for a file under its current inputs, with the given context environment. */
function recordGreen(store, file, inputKey, environment = ENVIRONMENT) {
  const context = { node: process.version, platform: process.platform, arch: process.arch, environment };
  const id = randomUUID(), at = new Date().toISOString();
  const completion = { id, commit: HEAD, tree: TREE, code: 0, signal: null, outputSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64), toolingSha256: TOOLING };
  storeTestResult(store, { version: 2, key: testResultDigest({ inputKey, context }), file, inputKey, context, status: 'pass', stage: 'test', commit: HEAD, node: process.version, at,
    tap: { lines: ['ok 1 - recorded case [C7]'], counts: { tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0 }, observedTests: 1,
      testOutcomes: [{ file, name: 'recorded case [C7]', passed: true, skipped: false }] },
    origin: { machine: 'runner-a', stage: 'test', commit: HEAD, at, request: id, completion } });
}

test('clause 1: a file with a runner-completed green under the same inputs is reused and named, one without runs [C7]', async () => {
  const scratch = scratchEnv();
  try {
    const none = await preQueueReuse(ROOT, HEAD, [FILE, OTHER], TOOLING, { env: scratch.env });
    assert.deepEqual(none.run, [FILE, OTHER], 'no recorded green: everything runs as before');
    recordGreen(scratch.store, FILE, await inputKeyOf(scratch.env, FILE));
    const split = await preQueueReuse(ROOT, HEAD, [FILE, OTHER], TOOLING, { env: scratch.env });
    assert.deepEqual(split.run, [OTHER], 'only the file without a green still queues');
    assert.deepEqual([...split.reused.keys()], [FILE]);
    const receipt = reuseReceipt(split.reused, { tap: true });
    assert.match(receipt, new RegExp(`^# reused ${split.reused.get(FILE).key} from test ${HEAD} \\(${FILE.replaceAll('.', '\\.')}\\)\n`, 'u'));
    assert.match(receipt, /ok 1 - recorded case \[C7\]\n# pass 1\n# fail 0\n# skipped 0\n$/u);
  } finally { scratch.done(); }
});

test('clause 1: a green from another tooling sha, another environment or an unfinished request is never reused [C7]', async () => {
  const scratch = scratchEnv();
  try {
    const inputKey = await inputKeyOf(scratch.env, FILE);
    recordGreen(scratch.store, FILE, inputKey, ENVIRONMENT.map(([name, value]) => [name, name === 'TZ' ? 'America/Chicago' : value]));
    assert.deepEqual((await preQueueReuse(ROOT, HEAD, [FILE], TOOLING, { env: scratch.env })).run, [FILE], 'a green under another TZ is not the runner\'s context');
    recordGreen(scratch.store, FILE, inputKey);
    assert.deepEqual((await preQueueReuse(ROOT, HEAD, [FILE], 'd'.repeat(64), { env: scratch.env })).run, [FILE], 'another tooling sha runs');
    assert.deepEqual((await preQueueReuse(ROOT, HEAD, [FILE], TOOLING, { env: { ...scratch.env, PULLBOARD_TEST_REUSE: '0' } })).run, [FILE], 'an opted-out run consults nothing');
    assert.deepEqual((await preQueueReuse(ROOT, HEAD, [FILE], TOOLING, { env: scratch.env, runtimes: [{ node: 'v0.0.0', platform: 'x', arch: 'y' }] })).run, [FILE], 'another runtime runs');
    assert.deepEqual((await preQueueReuse(ROOT, HEAD, ['not/a/test.js'], TOOLING, { env: scratch.env })).run, ['not/a/test.js'], 'a keyless path runs');
  } finally { scratch.done(); }
});

test('clause 2: a record-only run consults no green, so a census sample still runs every file [C7]', async () => {
  const scratch = scratchEnv();
  try {
    assert.equal(RECORD_ONLY_PREFIX, 'PULLBOARD_TEST_REUSE=record');
    const names = ENVIRONMENT.map(([name]) => name);
    // A green under this process's own context, so only the consult rule decides whether planTestActions reuses it.
    const own = { ...scratch.env, PULLBOARD_TEST_CACHE_TOOLING: TOOLING };
    recordGreen(scratch.store, FILE, await inputKeyOf(own, FILE), names.map(name => [name, own[name] ?? null]));
    const plan = async (env) => {
      const written = [];
      const result = await planTestActions(ROOT, [`./${FILE}`], { fullSuite: false, listFiles: () => [`./${FILE}`], env, write: text => written.push(text) });
      return { result, text: written.join('') };
    };
    const consulted = await plan({ ...own });
    assert.equal(consulted.result.done, true, 'an ordinary run reuses the recorded green');
    assert.match(consulted.text, /# reused [0-9a-f]{64} from test /u);
    const recording = await plan({ ...own, PULLBOARD_TEST_REUSE: 'record' });
    assert.equal(recording.result.done, false, 'a record-only run still runs the file');
    assert.ok(!recording.text.includes('# reused'), 'its receipt names no reused file');
  } finally { scratch.done(); }
});

test('clause 2: a record-only command asks for its own greens back and sends none out [C7]', async () => {
  const scratch = scratchEnv();
  try {
    const command = `${RECORD_ONLY_PREFIX} node packages/gate/src/io/run/tests.js './${FILE}'`;
    const previous = process.env.PULLBOARD_TEST_RESULT_STORE;
    process.env.PULLBOARD_TEST_RESULT_STORE = scratch.store;
    try {
      recordGreen(scratch.store, FILE, await inputKeyOf(scratch.env, FILE));
      const exchange = await prepareTestResultExchange(ROOT, command, HEAD);
      assert.equal(exchange.inputKeys.length, 1, 'the file\'s input key is named so its green comes back');
      assert.equal(exchange.packet, null, 'no stored green is sent');
    } finally {
      if (previous === undefined) delete process.env.PULLBOARD_TEST_RESULT_STORE; else process.env.PULLBOARD_TEST_RESULT_STORE = previous;
    }
  } finally { scratch.done(); }
});
