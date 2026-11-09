/** A submit proof's test files run at once across free runner slots and record one combined receipt [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { PROOF_BATCH_FILES, freeRunnerSlots, mergeShardRuns, proofShardCount, runProofShards } from '../packages/gate/src/shell/proof-shards.js';
import { proofFields } from '../packages/verify/index.js';
import { privateFixtureFiles } from './fixture-child.js';

const FILES = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js'];
const FILE_MS = { 'test/a.test.js': 300, 'test/b.test.js': 200, 'test/c.test.js': 250, 'test/d.test.js': 100 };

/**
 * Shard runners on an injected clock: each call starts at the clock's current time and ends when the test releases it,
 * which advances the clock to that call's end. Serial calls would start at later times; parallel ones all start at 0.
 */
function clockedRunners(count) {
  const clock = { now: 0 };
  const calls = [];
  let allStarted;
  const started = new Promise(resolve => { allStarted = resolve; });
  /** One shard run that waits for the test to release it. */
  const run = label => files => new Promise(resolve => {
    calls.push({ label, files, startedAt: clock.now, finish: () => {
      clock.now = Math.max(clock.now, calls.find(call => call.files === files).startedAt + Math.max(...files.map(file => FILE_MS[file])));
      resolve({ isGreen: true, exitCode: 0, output: `ok ${files.join(' ')}`, executionRunner: `runner-${label}` });
    } });
    if (calls.length === count) allStarted();
  });
  return { clock, calls, started, runFirst: run('gate'), runOther: run('other') };
}

/** The proof fields of a version-two receipt for this merged run, as the gate writes them. */
function receiptProof(run) {
  return { item: 3469, frozenDigest: null, seat: 'core-1', runner: null, exitCode: run.exitCode, environment: null,
    counts: { passed: null, failed: null, skipped: null }, durationMs: 0, sourceClean: true, shards: run.shards };
}

test('clause 1: prove fans proof files across free slots into one receipt: N files on N free slots start together and finish near the slowest file [C7]', { timeout: 10_000 }, async () => {
  const runners = clockedRunners(FILES.length);
  const proof = runProofShards(FILES, { freeSlots: FILES.length - 1, batchFiles: 1, runFirst: runners.runFirst, takeSlot: lane => lane(runners.runOther) });
  // Every shard is called before any is released; one-after-another calls would never reach this count.
  await runners.started;
  assert.deepEqual(runners.calls.map(call => call.startedAt), FILES.map(() => 0), 'all N runs start together');
  for (const call of [...runners.calls].sort((x, y) => FILE_MS[x.files[0]] - FILE_MS[y.files[0]])) call.finish();
  const shards = await proof;
  assert.equal(shards.length, FILES.length, 'one shard per file when every file has a slot');
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), FILES, 'every file runs exactly once');
  const slowest = Math.max(...Object.values(FILE_MS));
  assert.ok(runners.clock.now < slowest * 1.5, `the proof's wall time ${runners.clock.now} ms stays under 1.5x the slowest file's ${slowest} ms`);
});

test('clause 1: prove fans proof files across free slots into one receipt: 6 files on 3 free slots run one parallel pass of 3 shards, not 2 sequential batches [C7]', { timeout: 10_000 }, async () => {
  const six = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js', 'test/e.test.js', 'test/f.test.js'];
  assert.equal(proofShardCount(six.length, { batchFiles: PROOF_BATCH_FILES }), 2, 'batches of 3 would make 2 batches');
  assert.equal(proofShardCount(six.length, { freeSlots: 3 }), 3, 'with no batch size the files split one shard per free slot');
  assert.equal(proofShardCount(six.length, { freeSlots: 18 }), 3, 'a pool with 18 free slots still opens at most PROOF_MAX_SHARDS controllers per gate');
  const calls = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let allStarted;
  const started = new Promise(resolve => { allStarted = resolve; });
  /** One shard run that stays open until the test releases every run, so a sequential second batch could never start. */
  const run = label => async files => {
    calls.push({ label, files });
    if (calls.length === 3) allStarted();
    await held;
    return { isGreen: true, exitCode: 0, output: `ok ${files.join(' ')}`, executionRunner: `runner-${label}` };
  };
  const proof = runProofShards(six, { freeSlots: 3, retryMs: 10, runFirst: run('gate'), takeSlot: lane => lane(run('slot')) });
  await started;
  assert.equal(calls.length, 3, 'three shards are running at once before any has finished');
  assert.deepEqual(calls.map(call => call.files.length), [2, 2, 2], 'each shard holds a third of the files');
  assert.deepEqual(calls.map(call => call.label).sort(), ['gate', 'slot', 'slot'], 'the gate lane and two slot lanes each run one shard');
  release();
  const shards = await proof;
  assert.equal(calls.length, 3, 'no lane ran a second batch after its first');
  assert.equal(shards.length, 3);
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), six, 'every file runs exactly once');
});

test('clause 1: prove fans proof files across free slots into one receipt: the merged run is one receipt holding each shard\'s files [C7]', async () => {
  const red = async files => ({ isGreen: false, exitCode: 1, output: `not ok ${files[0]}`, executionRunner: 'runner-red', remoteWallMs: 5 });
  const green = async files => ({ isGreen: true, exitCode: 0, output: `ok ${files[0]}`, executionRunner: 'runner-green', remoteWallMs: 7 });
  const merged = mergeShardRuns(await runProofShards(FILES.slice(0, 2), { freeSlots: 1, batchFiles: 1, runFirst: green, takeSlot: lane => lane(red) }));
  assert.equal(merged.isGreen, false, 'one red shard makes the whole proof red');
  assert.equal(merged.exitCode, 1);
  assert.match(merged.output, /ok test\/a\.test\.js[\s\S]*not ok test\/b\.test\.js/u, 'one output holds every shard');
  const proof = proofFields(receiptProof(merged));
  assert.deepEqual(proof.shards, [
    { files: ['test/a.test.js'], exitCode: 0, runner: 'runner-green', durationMs: 7 },
    { files: ['test/b.test.js'], exitCode: 1, runner: 'runner-red', durationMs: 5 },
  ], 'the receipt keeps each shard\'s files, exit and runner');
  assert.equal(proofFields({ ...receiptProof(merged), shards: [{ files: ['/abs.test.js'], exitCode: 0, runner: null, durationMs: 1 }] }), null,
    'a malformed shard row refuses the receipt');
  const { shards: _dropped, ...unsharded } = receiptProof(merged);
  assert.ok(!Object.hasOwn(proofFields(unsharded), 'shards'), 'a receipt without shards reads as before');
});

test('clause 1: prove fans proof files across free slots into one receipt: one batch behaves as today, and batches no slot takes run on the gate lease [C7]', async () => {
  const calls = [];
  const record = label => async files => { calls.push({ label, files }); return { isGreen: true, exitCode: 0, output: '' }; };
  assert.equal(await runProofShards(FILES, { freeSlots: 3, batchFiles: FILES.length, runFirst: record('gate'), takeSlot: lane => lane(record('other')) }), null,
    'files that make one batch give no queue, so the caller runs the single command');
  assert.deepEqual(calls, [], 'nothing ran as batches');
  const refused = async () => { throw Object.assign(new Error('no runner'), { code: 'RUNNER_UNAVAILABLE' }); };
  const shards = await runProofShards(FILES.slice(0, 2), { freeSlots: 1, batchFiles: 1, retryMs: 10, runFirst: record('gate'), takeSlot: refused });
  assert.deepEqual(calls.map(call => call.label), ['gate', 'gate'], 'a batch no slot took runs on the gate lease after the first');
  assert.deepEqual(shards.map(shard => shard.files), [['test/a.test.js'], ['test/b.test.js']]);
});

test('clause 1: prove fans proof files across free slots into one receipt: free slots are runner capacity less held and waiting slots [C7]', () => {
  const inputs = privateFixtureFiles('pullboard-shard-pool-');
  try {
    const file = join(inputs.root, 'resources.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE resource (name TEXT PRIMARY KEY, capacity INTEGER);
      CREATE TABLE holder (name TEXT); CREATE TABLE waiter (name TEXT);
      INSERT INTO resource VALUES ('runner:a', 6), ('runner:b', 4), ('gate', 2);
      INSERT INTO holder VALUES ('runner:a'), ('runner:b'), ('gate');
      INSERT INTO waiter VALUES ('gate');`);
    db.close();
    assert.equal(freeRunnerSlots(file), 7, '10 runner slots, 2 held, 1 waiting');
    assert.equal(freeRunnerSlots(join(inputs.root, 'missing.sqlite')), 0, 'no pool counts as no free slot');
  } finally { rmSync(inputs.root, { recursive: true, force: true }); }
});
