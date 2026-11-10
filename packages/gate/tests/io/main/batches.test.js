/** A gate pulls its proof's test batches from a queue into every runner slot it can get, not a shard plan fixed at start [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { takeResource } from '../../../../resources/index.js';
import { BATCH_DROP_LIMIT } from '../../../src/io/shards/proof.js';
import { PROOF_MAX_SHARDS } from '../../../src/io/shards/proof.js';
import { freeRunnerSlots } from '../../../src/io/shards/proof.js';
import { proveBatches } from '../../../src/io/shards/proof.js';
import { shardSlotOptions } from '../../../src/io/shards/proof.js';
import { formatTestOutcomes } from '../../../src/io/test/outcomes.js';
import { readTestOutcomes } from '../../../src/io/test/outcomes.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { waitForCondition } from '../../../../../apps/cli/tests/fixtures/runner/holders.js';

const FILES = Array.from({ length: 60 }, (_, index) => `test/f${String(index).padStart(2, '0')}.test.js`);
const RUNNERS = [{ host: 'fixture-a', slots: 6, browser: 0 }];
const TREE = 'c'.repeat(40);
const COMMIT = 'd'.repeat(40);
const COMMAND = 'node packages/gate/src/io/run/tests.js ';
/** A short slot admission window, so a request that finds no slot asks again within the test. */
const ADMIT_MS = 1_000;
/** The wall time each fixture batch reports. */
const BATCH_MS = 200;

/** The submit's file command, as gate-submit writes it. */
const filesCommand = files => COMMAND + files.map(file => './' + file).join(' ');

/** Own a private machine home and its resource pool, so the pool and the shard pass store are this test's alone. */
function machine(t) {
  const { root: directory } = privateFixtureFiles('pullboard-pull-batches-');
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(directory, 'machine');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, pool: join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite') };
}

/** A submit gate's runner-only slot options on the real machine queue, as gate-submit builds them for a proof. */
function gateOptions(box, agent) {
  return { name: 'gate', scope: 'machine', root: box.directory, repo: box.directory, capacity: 0, browserCapacityProvider: () => 0,
    itemCheck: true, agent, item: '3711', kind: 'submit', runnerOnly: true, remote: true, runnerWaitMs: 1_800_000,
    runnerDeadlineAt: Date.now() + 1_800_000, runnerProvider: () => RUNNERS };
}

/** Take one runner slot at once; a wait here means the fixture pool is wrong. */
function hold(options) {
  return takeResource({ ...options, onWait() { throw new Error('a free runner slot exists; this lease must not queue'); } });
}

/** Count the rows of one pool table. */
function rows(pool, table) {
  const db = new DatabaseSync(pool, { readOnly: true });
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } finally { db.close(); }
}

/** One green batch run on a lane, printing its files' outcome frames under the proof's timing run id, as a runner does. */
function batchRun(timingRunId, lane, files) {
  return { isGreen: true, exitCode: 0, executionRunner: 'fixture-a', remoteWallMs: BATCH_MS, executionSource: { commit: COMMIT, tree: TREE },
    output: `ok ${lane} ${files.join(' ')}\n${formatTestOutcomes(timingRunId, files.map(file => ({ file, name: `${file} case`, passed: true, skipped: false })))}` };
}

test('clause 1: a gate whose pool has 0 free slots and frees 5 mid-run pulls its batches into PROOF_MAX_SHARDS lanes, and every file runs once [C7]', { timeout: 60_000 }, async t => {
  const box = machine(t);
  const own = await hold(gateOptions(box, 'core-gate'));
  const others = [];
  for (let index = 0; index < 5; index += 1) others.push(await hold(gateOptions(box, `core-other-${index}`)));
  const slotLeases = [];
  try {
    const freeSlots = freeRunnerSlots(box.pool);
    assert.equal(freeSlots, 0, 'the gate holds 1 of 6 runner slots and other gates hold the other 5');
    const timingRunId = randomUUID();
    const runs = [];
    let running = 0, freed = false, open;
    // Every batch runs until the test opens the gates, so the test sees how many lanes run batches at once.
    const opened = new Promise(resolve => { open = resolve; });
    /** One batch on a lane: counted while it runs, noting whether the pool had freed its slots when it started. */
    const run = async (lane, files) => {
      runs.push({ lane, files, afterFree: freed });
      running += 1;
      await opened;
      running -= 1;
      return batchRun(timingRunId, lane, files);
    };
    const runOnRunnerAsync = (root, command, options) => {
      assert.equal(options.metadata.timingRunId, timingRunId);
      return run('gate', command.slice(COMMAND.length).split(' ').map(file => file.replace(/^\.\//u, '')));
    };
    const execution = { gateLease: { runner: own.runner, executionServices: { runners: { runOnRunnerAsync } } },
      remoteCommand: filesCommand(FILES), remoteOptions: { source: { commit: COMMIT, tree: TREE }, metadata: { timingRunId } } };
    // gate-submit's takeSlot on the real machine queue: one more runner-only slot, held while its lane pulls batches.
    const takeSlot = async (lane, { closed }) => {
      const lease = await takeResource({ ...shardSlotOptions(gateOptions(box, 'core-gate'), { admitMs: ADMIT_MS, closed }), runnerProvider: () => RUNNERS });
      slotLeases.push(lease.runner?.host);
      try { return await lane(files => run(lease.token, files)); } finally { lease.release(); }
    };
    const notes = [];
    const proof = proveBatches('/controller', execution, { files: FILES, filesCommand, takeSlot, freeSlots, batchFiles: 2, retryMs: 50, say: line => notes.push(line) });
    // Mid-run: the gate's own lane runs its first batch and its slot request waits in the pool's queue.
    await waitForCondition(() => runs.length === 1 && rows(box.pool, 'waiter') === 1, 'the gate lane running and one slot request queued', { signal: t.signal });
    // The five other gates finish and free their slots.
    freed = true;
    for (const lease of others.splice(0)) lease.release();
    await waitForCondition(() => running === PROOF_MAX_SHARDS, 'the gate lane and its capped slot lanes running batches at once', { signal: t.signal });
    // With the capped lanes admitted, no further request queues or holds a slot although 5 slots are free.
    assert.equal(rows(box.pool, 'holder'), PROOF_MAX_SHARDS, 'the gate holds only its capped lanes');
    assert.equal(rows(box.pool, 'waiter'), 0, 'no slot request beyond the cap is queued');
    open();
    const merged = await proof;

    const slotRuns = runs.filter(row => row.lane !== 'gate');
    assert.equal(new Set(slotRuns.map(row => row.lane)).size, PROOF_MAX_SHARDS - 1, 'the run pulled batches into the capped lanes only');
    assert.ok(runs.filter(row => !row.afterFree).every(row => row.lane === 'gate'), 'before the pool freed, only the gate\'s own lane ran');
    assert.ok(slotRuns.every(row => row.afterFree), 'every freed slot joined after it was freed, not from a plan at gate start');
    assert.ok(slotLeases.every(host => host === 'fixture-a'), 'every slot the gate took is a runner slot');
    assert.deepEqual(runs.flatMap(row => row.files).sort(), FILES, 'every proof file ran exactly once');
    assert.equal(merged.isGreen, true);
    assert.deepEqual(merged.shards.flatMap(shard => shard.files).sort(), FILES, 'the one receipt names every file once');
    assert.deepEqual(readTestOutcomes(merged.output, timingRunId).map(row => row.file).sort(), FILES, 'every file is accounted for under the proof\'s one timing run id');
    assert.match(notes.join('\n'), new RegExp(`proof ran 30 batches on the gate's lane and up to ${PROOF_MAX_SHARDS - 1} more runner slots`, 'u'));
    // The request still queued when the batches ran out ends instead of holding a slot it no longer needs.
    await waitForCondition(() => rows(box.pool, 'waiter') === 0 && rows(box.pool, 'holder') === 1,
      'no slot request left waiting and only the gate\'s own lease held once the queue is empty', { signal: t.signal });
  } finally { for (const lease of [...others, own]) lease.release(); }
});

test('clause 1: a batch whose runner drops returns to the queue and runs once on another lane [C7]', async () => {
  const timingRunId = randomUUID();
  const calls = [];
  let slotsTaken = 0;
  /** The first batch on the first slot loses its runner; every other batch passes. */
  const run = async (lane, files) => {
    calls.push({ lane, files });
    await Promise.resolve();
    if (lane === 'slot-1' && calls.filter(call => call.lane === 'slot-1').length === 1) {
      throw Object.assign(new Error('runner fixture-a dropped'), { code: 'RUNNER_UNAVAILABLE', runnerHost: 'fixture-a' });
    }
    return batchRun(timingRunId, lane, files);
  };
  const execution = { gateLease: { runner: { host: 'fixture-gate' }, executionServices: { runners: {
    runOnRunnerAsync: (root, command) => run('gate', command.slice(COMMAND.length).split(' ').map(file => file.replace(/^\.\//u, ''))) } } },
  remoteCommand: filesCommand(FILES), remoteOptions: { source: { commit: COMMIT, tree: TREE }, metadata: { timingRunId } } };
  const takeSlot = async lane => {
    slotsTaken += 1;
    const label = `slot-${slotsTaken}`;
    return lane(files => run(label, files));
  };
  const files = FILES.slice(0, 12);
  const merged = await proveBatches('/controller', execution, { files, filesCommand, takeSlot, freeSlots: 2, batchFiles: 2, retryMs: 10, passes: null });
  const dropped = calls.find(call => call.lane === 'slot-1').files;
  const reruns = calls.filter(call => call.files.join() === dropped.join());
  assert.equal(reruns.length, 2, 'the dropped batch ran again');
  assert.notEqual(reruns[1].lane, 'slot-1', 'it ran again on another lane');
  assert.equal(merged.isGreen, true);
  assert.deepEqual(merged.shards.flatMap(shard => shard.files).sort(), files, 'the receipt names every file once; the dropped attempt is not in it');
});

/** A green fixture run, or a runner drop on the named lane's first batch only. */
function dropFirstOn(dropLane, timingRunId, calls) {
  return async (lane, files) => {
    calls.push({ lane, files });
    await Promise.resolve();
    if (lane === dropLane && calls.filter(call => call.lane === dropLane).length === 1) {
      throw Object.assign(new Error(`runner of ${lane} dropped`), { code: 'RUNNER_UNAVAILABLE', runnerHost: 'fixture-a' });
    }
    return batchRun(timingRunId, lane, files);
  };
}

/** A runner-lease execution whose gate lane runs batches through `run`. */
function runnerExecution(run, timingRunId) {
  return { gateLease: { runner: { host: 'fixture-gate' }, executionServices: { runners: {
    runOnRunnerAsync: (root, command) => run('gate', command.slice(COMMAND.length).split(' ').map(file => file.replace(/^\.\//u, ''))) } } },
  remoteCommand: filesCommand(FILES), remoteOptions: { source: { commit: COMMIT, tree: TREE }, metadata: { timingRunId } } };
}

test('clause 1: a batch whose runner drops on the gate\'s own first lane returns to the queue and runs once on a slot lane [C7]', async () => {
  const timingRunId = randomUUID();
  const calls = [];
  const run = dropFirstOn('gate', timingRunId, calls);
  let slotsTaken = 0;
  const takeSlot = async lane => { slotsTaken += 1; const label = `slot-${slotsTaken}`; return lane(files => run(label, files)); };
  const files = FILES.slice(0, 12);
  const notes = [];
  const merged = await proveBatches('/controller', runnerExecution(run, timingRunId), { files, filesCommand, takeSlot, freeSlots: 2, batchFiles: 2, retryMs: 10, passes: null, say: line => notes.push(line) });
  const dropped = calls[0];
  assert.equal(dropped.lane, 'gate', 'the drop happened on the gate\'s own first lane');
  const reruns = calls.filter(call => call.files.join() === dropped.files.join());
  assert.equal(reruns.length, 2, 'the dropped batch ran again');
  assert.match(reruns[1].lane, /^slot-/u, 'it ran again on a slot lane, not back on the lane that dropped it');
  assert.equal(merged.isGreen, true, 'the drop did not refuse the proof');
  assert.deepEqual(merged.shards.flatMap(shard => shard.files).sort(), files, 'the receipt names every file once; the dropped attempt is not in it');
  assert.match(notes.join('\n'), /proof batch returned to the queue: the gate's own runner dropped it \(RUNNER_UNAVAILABLE\)/u);
});

test('clause 1: when the gate\'s own lane drops a batch and no slot can be had, the gate asks for one and then runs the batch again itself [C7]', async () => {
  const timingRunId = randomUUID();
  const calls = [];
  const run = dropFirstOn('gate', timingRunId, calls);
  let requests = 0;
  const takeSlot = async () => { requests += 1; throw Object.assign(new Error('no runner slot'), { code: 'RUNNER_WAIT_DEADLINE' }); };
  const files = FILES.slice(0, 6);
  const merged = await proveBatches('/controller', runnerExecution(run, timingRunId), { files, filesCommand, takeSlot, freeSlots: 0, batchFiles: 2, retryMs: 10, passes: null });
  assert.ok(requests >= 1, 'the gate asked for another slot after its own drop');
  assert.ok(calls.every(call => call.lane === 'gate'), 'with no slot to be had, the gate\'s own lane ran every batch');
  assert.equal(calls.filter(call => call.files.join() === calls[0].files.join()).length, 2, 'the dropped batch ran once more');
  assert.equal(merged.isGreen, true);
  assert.deepEqual(merged.shards.flatMap(shard => shard.files).sort(), files, 'every file once');
});

test('clause 1: a batch that drops every runner it lands on refuses the proof after BATCH_DROP_LIMIT returns, so the gate reruns on infrastructure [C7]', async () => {
  const timingRunId = randomUUID();
  const calls = [];
  const poison = new Set([FILES[0]]);
  const run = async (lane, files) => {
    calls.push({ lane, files });
    await Promise.resolve();
    if (files.some(file => poison.has(file))) throw Object.assign(new Error('runner dropped'), { code: 'RUNNER_UNAVAILABLE' });
    return batchRun(timingRunId, lane, files);
  };
  const takeSlot = async lane => lane(files => run('slot', files));
  await assert.rejects(proveBatches('/controller', runnerExecution(run, timingRunId), { files: FILES.slice(0, 6), filesCommand, takeSlot, freeSlots: 2, batchFiles: 2, retryMs: 10, passes: null }),
    error => error.code === 'RUNNER_UNAVAILABLE');
  assert.equal(calls.filter(call => call.files.some(file => poison.has(file))).length, BATCH_DROP_LIMIT + 1, 'the batch ran once and went back BATCH_DROP_LIMIT times');
});

test('clause 2: with no runners registered the same path runs the batches in one local lane [C7]', { timeout: 30_000 }, async t => {
  const box = machine(t);
  assert.equal(freeRunnerSlots(box.pool), 0, 'no runner is registered on this machine');
  let requested = 0;
  const takeSlot = async () => { requested += 1; throw new Error('a gate with no runner lease must not ask for a runner slot'); };
  const files = FILES.slice(0, 8);
  const notes = [];
  // A local gate lease, as withGateSlot hands it with no runner registered: no runner, the plan's local shell options.
  const execution = { gateLease: { executionServices: { runners: {} } }, localOptions: {} };
  const echo = batch => `echo lane ${batch.join(' ')}`;
  const run = await proveBatches(box.directory, execution, { files, filesCommand: echo, takeSlot, freeSlots: 5, batchFiles: 2, say: line => notes.push(line) });
  assert.equal(requested, 0, 'no runner slot was requested');
  assert.equal(run.isGreen, true);
  assert.deepEqual(run.output.split('\n').filter(line => line.startsWith('lane ')), [`lane ${files.join(' ')}`],
    'the one local lane pulled all 4 batches and ran them as one command over every file');
  assert.equal(Object.hasOwn(run, 'shards'), false, 'the run is today\'s single local run, not a merge');
  assert.deepEqual(notes, []);
});
