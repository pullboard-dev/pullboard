/** A gate rerun after an infrastructure end runs only the proof shards with no recorded pass for the same tree [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BATCH_DROP_LIMIT } from '../../../src/io/shards/proof.js';
import { proveBatches } from '../../../src/io/shards/proof.js';
import { shardPassStore } from '../../../src/io/shards/proof.js';
import { reusedShardFiles } from '../../../src/io/shards/proof.js';
import { submitGateAdmission } from '../../../src/io/submit.js';
import { readTestOutcomes } from '../../../src/io/test/outcomes.js';
import { formatTestOutcomes } from '../../../src/io/test/outcomes.js';
import { INFRASTRUCTURE_CODES } from '../../../src/io/requeue.js';
import { submitUntilSettled } from '../../../src/io/requeue.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const FILES = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js'];
const TREE = 'c'.repeat(40);
const COMMIT = 'd'.repeat(40);
const COMMAND = 'node apps/cli/src/io/run/tests.js ';

/** Own a private machine home, so the default shard pass store is this test's alone. */
function machine(t) {
  const { root } = privateFixtureFiles('pullboard-shard-reuse-');
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/**
 * One gate attempt's runner proof as gate-submit's proveShards builds it: a fresh timing run id per attempt, the gate's
 * lease running the first batch and every other batch in a slot of its own, one file per batch. `drop(files)` returns a refusal for a
 * shard whose runner drops. Every shard run prints its files' outcome frames under the attempt's id, as a runner does.
 */
function attempt({ tree = TREE, drop = () => null, calls }) {
  const timingRunId = randomUUID();
  const run = (lane, files) => {
    calls.push({ lane, files, timingRunId });
    const refusal = drop(files, lane);
    if (refusal) return Promise.reject(refusal);
    return Promise.resolve({ isGreen: true, exitCode: 0, executionRunner: `runner-${files[0]}`, remoteWallMs: 1000 + files.length,
      executionSource: { commit: COMMIT, tree },
      output: `ok ${files.join(' ')}\n${formatTestOutcomes(timingRunId, files.map(file => ({ file, name: `${file} case`, passed: true, skipped: false })))}` });
  };
  const runOnRunnerAsync = (root, command, options) => {
    assert.equal(options.metadata.timingRunId, timingRunId, 'the gate lease runs under this attempt\'s timing run id');
    return run('gate', command.slice(COMMAND.length).split(' ').map(file => file.replace(/^\.\//u, '')));
  };
  const execution = { gateLease: { runner: { host: 'fixture-gate' }, executionServices: { runners: { runOnRunnerAsync } } }, remoteCommand: COMMAND + FILES.join(' '),
    remoteOptions: { source: { commit: COMMIT, tree }, metadata: { timingRunId } } };
  return { timingRunId, execution, takeSlot: lane => lane(files => run('slot', files)) };
}

/** The submit's file command, as gate-submit writes it. */
const filesCommand = files => COMMAND + files.map(file => './' + file).join(' ');

test('clause 1: a gate rerun after RUNNER_UNAVAILABLE runs only the shard with no pass for the same tree, and the passed shards go into the combined receipt unchanged [C7]', async t => {
  machine(t);
  const calls = [];
  const attempts = [];
  const notes = [];
  let poisoned = null;
  const settled = await submitUntilSettled(async number => {
    // Attempt 1: the batch the gate lease runs first drops its runner on every lane it lands on, past the requeue bound
    // (BATCH_DROP_LIMIT), so the attempt ends on infrastructure; the three other batches pass for this tree.
    const gate = attempt({ calls, drop: (files, lane) => {
      if (number !== 1) return null;
      if (lane === 'gate' && !poisoned) poisoned = files.join();
      return files.join() === poisoned ? Object.assign(new Error('runner fixture-a dropped'), { code: 'RUNNER_UNAVAILABLE', runnerHost: 'fixture-a' }) : null;
    } });
    attempts.push(gate);
    return proveBatches('/controller', gate.execution, { files: FILES, filesCommand, takeSlot: gate.takeSlot, batchFiles: 1, retryMs: 10, freeSlots: FILES.length - 1, say: line => notes.push(line) });
  }, { healthy: async () => true, wait: async () => {} });
  assert.ok(INFRASTRUCTURE_CODES.has('RUNNER_UNAVAILABLE'));
  assert.deepEqual(settled.attempts.map(row => row.code), ['RUNNER_UNAVAILABLE'], 'the real rerun loop treated the drop as infrastructure');
  const [first, second] = attempts;
  const firstCalls = calls.filter(call => call.timingRunId === first.timingRunId);
  const secondCalls = calls.filter(call => call.timingRunId === second.timingRunId);
  assert.deepEqual([...new Set(firstCalls.flatMap(call => call.files))].sort(), FILES, 'attempt 1 fanned every file out');
  const dropped = firstCalls.find(call => call.lane === 'gate').files;
  assert.equal(firstCalls.filter(call => call.files.join() === dropped.join()).length, BATCH_DROP_LIMIT + 1, 'the dropped batch went back on the queue up to the bound');
  assert.deepEqual(secondCalls.map(call => call.files), [dropped], 'the rerun ran only the dropped shard\'s files');
  assert.match(notes.join('\n'), /reuses 3 of 4 files that passed for tree cccccccccccc; running 1/u);

  const merged = settled.result;
  assert.equal(merged.isGreen, true);
  assert.deepEqual(merged.shards.map(shard => shard.files).flat().sort(), FILES, 'the combined receipt names every file exactly once');
  const passedFirst = firstCalls.filter(call => call.lane === 'slot' && call.files.join() !== dropped.join()).map(call => call.files);
  const reusedRows = merged.shards.filter(shard => passedFirst.some(files => files.join() === shard.files.join()));
  assert.deepEqual(reusedRows, passedFirst.map(files => ({ files, exitCode: 0, runner: `runner-${files[0]}`, durationMs: 1000 + files.length })),
    'each passed shard enters the receipt with the files, exit, runner and duration it ran with');
  for (const files of passedFirst) assert.match(merged.output, new RegExp(`^ok ${files.join(' ')}$`, 'mu'), 'the passed shard\'s output is kept');
  const outcomes = readTestOutcomes(merged.output, second.timingRunId);
  assert.deepEqual(outcomes.map(row => row.file).sort(), FILES, 'every file is accounted for under the rerun\'s one timing run id');
  assert.equal(readTestOutcomes(merged.output, first.timingRunId), null, 'no frame is left under the dropped attempt\'s id');
});

test('clause 1: a different tree, or a red shard, reuses nothing and runs those files again [C7]', async t => {
  const root = machine(t);
  const calls = [];
  const red = attempt({ calls, drop: () => null });
  const store = shardPassStore(TREE, filesCommand([]), { folder: join(root, 'passes') });
  const failing = { ...red, takeSlot: lane => lane(files => Promise.resolve({ isGreen: false, exitCode: 1, output: `not ok ${files[0]}` })) };
  const first = await proveBatches('/controller', failing.execution, { files: FILES, filesCommand, takeSlot: failing.takeSlot, batchFiles: 1, freeSlots: FILES.length - 1, passes: store });
  assert.equal(first.isGreen, false);
  // The gate's own lane runs green and the capped slot lanes red, so the gate lane may pull more than one shard.
  const green = store.read().length;
  assert.ok(green >= 1 && green <= FILES.length - 2, `only the green shards are recorded (${green})`);
  const again = attempt({ calls });
  const rerun = await proveBatches('/controller', again.execution, { files: FILES, filesCommand, takeSlot: again.takeSlot, batchFiles: 1, freeSlots: FILES.length - 1, passes: store });
  assert.equal(rerun.isGreen, true);
  assert.equal(calls.filter(call => call.timingRunId === again.timingRunId).length, FILES.length - green, 'the red shards run again; only the green ones are reused');

  const other = attempt({ calls, tree: 'e'.repeat(40) });
  await proveBatches('/controller', other.execution, { files: FILES, filesCommand, takeSlot: other.takeSlot, batchFiles: 1, freeSlots: FILES.length - 1 });
  assert.equal(calls.filter(call => call.timingRunId === other.timingRunId).length, FILES.length, 'another tree runs every shard');
  assert.equal(shardPassStore(null, filesCommand([])), null, 'a run with no pinned tree keeps no passes');
});

test('clause 1: a proof whose every file is reused requests no browser slot, and a proof with a file left to run still does [C7]', async t => {
  const root = machine(t);
  const store = shardPassStore(TREE, filesCommand([]), { folder: join(root, 'passes') });
  const timingRunId = randomUUID();
  for (const file of FILES.slice(0, 3)) {
    store.record({ files: [file], timingRunId, run: { isGreen: true, exitCode: 0, executionSource: { commit: COMMIT, tree: TREE }, output: `ok ${file}` } });
  }
  assert.deepEqual(reusedShardFiles(store, FILES), FILES.slice(0, 3), 'the recorded green shards cover three files');
  const plan = files => ({ check: '', selection: { full: false, files }, deferFullFallback: false, deferSelection: false, proofFiles: files });
  const options = { allowBrowserFreeChecks: false };
  assert.equal((await submitGateAdmission(root, plan(FILES), options)).browser, true, 'without reuse the proof asks for a browser slot');
  assert.equal((await submitGateAdmission(root, plan(FILES.slice(0, 3)), { ...options, reusedFiles: FILES.slice(0, 3) })).browser, false, 'a proof that reuses every file asks for none');
  assert.equal((await submitGateAdmission(root, plan(FILES), { ...options, reusedFiles: FILES.slice(0, 3) })).browser, true, 'a file still to run keeps the request');
});
