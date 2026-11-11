/** A submit proof's test files run at once across free runner slots and record one combined receipt [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { PROOF_BATCH_FILES } from '../../../src/io/shards/proof.js';
import { PROOF_MAX_SHARDS } from '../../../src/io/shards/proof.js';
import { PROOF_MIN_SHARD_MS } from '../../../src/io/shards/proof.js';
import { SHARD_ADMIT_MS } from '../../../src/io/shards/proof.js';
import { SHARD_STARTUP_MS } from '../../../src/io/shards/proof.js';
import { freeRunnerSlots } from '../../../src/io/shards/proof.js';
import { mergeShardRuns } from '../../../src/io/shards/proof.js';
import { proofShardCount } from '../../../src/io/shards/proof.js';
import { runProofShards } from '../../../src/io/shards/proof.js';
import { shardStartupMs } from '../../../src/io/shards/proof.js';
import { proofFields } from '../../../../verify/index.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';

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

test('clause 1: prove fans proof files across free slots into one receipt: N small shards on N free slots run at most PROOF_MAX_SHARDS at once, the rest as lanes free [C7]', { timeout: 10_000 }, async () => {
  const runners = clockedRunners(PROOF_MAX_SHARDS);
  const proof = runProofShards(FILES, { freeSlots: FILES.length - 1, batchFiles: 1, runFirst: runners.runFirst, takeSlot: lane => lane(runners.runOther) });
  // The capped lanes start together; the fourth shard waits on the queue instead of opening a fourth controller.
  await runners.started;
  assert.deepEqual(runners.calls.map(call => call.startedAt), Array(PROOF_MAX_SHARDS).fill(0), 'the capped lanes start together');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runners.calls.length, PROOF_MAX_SHARDS, 'no lane beyond the cap starts while the first ones run');
  const first = [...runners.calls].sort((x, y) => FILE_MS[x.files[0]] - FILE_MS[y.files[0]])[0];
  first.finish();
  while (runners.calls.length < FILES.length) await new Promise(resolve => setImmediate(resolve));
  for (const call of runners.calls.filter(call => call !== first)) call.finish();
  const shards = await proof;
  assert.equal(shards.length, FILES.length, 'shards stay one per file: the lanes are capped, not the shard count');
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), FILES, 'every file runs exactly once');
});

test('clause 1: prove fans proof files across free slots into one receipt: 6 files on 3 free slots run one parallel pass of 3 shards, not 2 sequential batches [C7]', { timeout: 10_000 }, async () => {
  const six = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js', 'test/e.test.js', 'test/f.test.js'];
  assert.equal(proofShardCount(six.length, { batchFiles: PROOF_BATCH_FILES }), 2, 'batches of 3 would make 2 batches');
  assert.equal(proofShardCount(six.length), PROOF_MAX_SHARDS, 'with no batch size the files split one shard per lane');
  assert.equal(proofShardCount(six.length, { lanes: 18 }), PROOF_MAX_SHARDS, 'never more shards than the lane cap, however many slots are free');
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

test('clause 1: prove fans proof files across free slots into one receipt: while the item check holds the gate lease, slot lanes start at once and the gate lane joins after [C7]', { timeout: 10_000 }, async () => {
  // #3841 (9 Nov): the item check ran 173 s alone on the gate's lease; its shards were admitted only after it ended.
  const six = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js', 'test/e.test.js', 'test/f.test.js'];
  const calls = [];
  let checkDone;
  const gateLaneFree = new Promise(resolve => { checkDone = resolve; });
  let slotsStarted;
  const started = new Promise(resolve => { slotsStarted = resolve; });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  /** One shard run; slot runs stay open until the test releases them, so the gate lane can only start beside them. */
  const run = label => async files => {
    calls.push({ label, files });
    if (calls.filter(call => call.label === 'slot').length === 2) slotsStarted();
    if (label === 'slot') await held;
    return { isGreen: true, exitCode: 0, output: `ok ${files.join(' ')}` };
  };
  const proof = runProofShards(six, { freeSlots: 3, retryMs: 10, runFirst: run('gate'), takeSlot: lane => lane(run('slot')), gateLaneFree });
  await started;
  assert.deepEqual(calls.map(call => call.label), ['slot', 'slot'], 'two slot lanes run shards while the check holds the gate lease');
  for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.some(call => call.label === 'gate'), false, 'the gate lane runs nothing until the check is done');
  checkDone();
  while (!calls.some(call => call.label === 'gate')) await new Promise(resolve => setImmediate(resolve));
  release();
  const shards = await proof;
  assert.deepEqual(calls.map(call => call.label).sort(), ['gate', 'slot', 'slot'], 'the gate lane takes the remaining shard once free');
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), six, 'every file runs exactly once');
});

test('clause 1: prove fans proof files across free slots into one receipt: each lane pays one dispatch, so 69 files on 18 free slots take 3 transfers and 3 READYs, not 23 [C7]', { timeout: 10_000 }, async () => {
  // #3883's proof shape (9 Nov): 69 owed files, 18 free slots, about 2 s each. Measured warm dispatch: 4 s transfer + 3.5 s READY.
  const DISPATCH_MS = 4_000 + 3_500;
  const files = Array.from({ length: 69 }, (_, index) => `test/f${String(index).padStart(2, '0')}.test.js`);
  const times = Object.fromEntries(files.map(file => [file, 2_000]));
  const calls = [];
  /** One dispatch on a lane; each costs one transfer and one READY. */
  const run = label => async batch => { calls.push({ label, batch }); return { isGreen: true, exitCode: 0, output: `ok ${batch.length}` }; };
  const shards = await runProofShards(files, { freeSlots: 18, times, retryMs: 10, runFirst: run('gate'), takeSlot: lane => lane(run('slot')) });
  assert.equal(calls.length, PROOF_MAX_SHARDS, 'one dispatch per lane');
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), files, 'every file runs exactly once');
  assert.deepEqual(calls.map(call => call.label).sort(), ['gate', 'slot', 'slot'], 'the gate lane and two slot lanes each dispatch once');
  assert.ok(Math.max(...calls.map(call => call.batch.length)) <= 23, 'the planner balances the files across the lanes');
  assert.ok(DISPATCH_MS <= 15_000, `each lane's transfer plus READY is one dispatch, ${DISPATCH_MS} ms, under the 15 s target`);
});

test('clause 1: prove fans proof files across free slots into one receipt: a proof whose recorded runtime fits one shard runs as one dispatch [C7]', async () => {
  assert.equal(proofShardCount(9, { expectedMs: PROOF_MIN_SHARD_MS - 1 }), 1, 'under one shard of work stays one command');
  assert.equal(proofShardCount(9, { expectedMs: PROOF_MIN_SHARD_MS * 2 }), 2, 'two shards of work split in two');
  assert.equal(proofShardCount(9, { expectedMs: PROOF_MIN_SHARD_MS * 40 }), PROOF_MAX_SHARDS, 'long proofs still stop at the lane cap');
  assert.equal(proofShardCount(9, { expectedMs: null }), PROOF_MAX_SHARDS, 'no recorded times split one shard per lane');
  const calls = [];
  const record = async batch => { calls.push(batch); return { isGreen: true, exitCode: 0, output: '' }; };
  const short = { 'test/a.test.js': 900, 'test/b.test.js': 800, 'test/c.test.js': 700, 'test/d.test.js': 600 };
  assert.equal(await runProofShards(FILES, { freeSlots: 3, times: short, runFirst: record, takeSlot: lane => lane(record) }), null,
    'four short files give no queue, so the caller runs the single command on the gate lease');
  assert.deepEqual(calls, [], 'no batch dispatched');
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

test('clause 1: a proof shard dispatch gets a 90 s startup budget, not its 30 s admission window, so a slow transfer is not a missed READY [C7]', () => {
  // 9 Nov: shard transfers ran 31 s at p50; with a 30 s budget a healthy runner missed READY and the shard reran.
  assert.equal(SHARD_ADMIT_MS, 30_000);
  assert.equal(shardStartupMs(SHARD_ADMIT_MS), SHARD_STARTUP_MS, 'the admission window no longer sets the startup budget');
  assert.equal(shardStartupMs(undefined), SHARD_STARTUP_MS);
  assert.equal(shardStartupMs(30 * 60_000), 30 * 60_000, 'a longer lease budget stands');
});
