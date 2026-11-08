/** A gate's proof shards never wait on browser leases the same gate holds, and an unplaceable shard ends in time [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { takeResource } from '../packages/resources/index.js';
import { privateFixtureFiles } from './fixture-child.js';
import { freeRunnerSlots, runProofShards, shardSlotOptions, SHARD_ADMIT_MS } from '../packages/gate/src/shell/proof-shards.js';

const RUNNERS = [{ host: 'fixture-a', slots: 4, browser: 2 }, { host: 'fixture-b', slots: 4, browser: 2 }];
const FILES = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js', 'test/e.test.js', 'test/f.test.js'];
/** A short shard admission window, so the unplaceable shard's bound is measured in seconds. */
const ADMIT_MS = 1_000;

/** The submit's captured runner admission under gate.runnersOnly with the MacBook's 30-minute gate.runnerWaitMs. */
const SUBMIT_WAIT_MS = 1_800_000;

/** Own a private machine pool; the two browser runners reach admission through each request's runnerProvider. */
function machine(t) {
  const { root: directory } = privateFixtureFiles('pullboard-shard-browser-');
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

/**
 * The gate's own slot options as gate-submit builds them for a browser proof: its captured submit runner admission
 * (runner-only with a 30-minute deadline) on the real machine queue, an item check that takes one infrastructure retry.
 */
function gateOptions(box) {
  return { name: 'gate', scope: 'machine', root: box.directory, repo: box.directory, capacity: 0, browserCapacityProvider: () => 0,
    browser: true, gui: false, itemCheck: true, infrastructureRetry: true, agent: 'core-1340', item: '3586', kind: 'submit',
    runnerOnly: true, remote: true, runnerWaitMs: SUBMIT_WAIT_MS, runnerDeadlineAt: Date.now() + SUBMIT_WAIT_MS, runnerProvider: () => RUNNERS };
}

/** Take one of the gate's own browser leases at once; a wait here means the fixture pool is wrong. */
function hold(options) {
  return takeResource({ ...options, onWait() { throw new Error('a free browser slot exists; the gate lease must not queue'); } });
}

test('clause 1: a gate whose shards hold every browser slot on one runner admits its next shards on the runner with free browser slots, planned by browser capacity [C7]', { timeout: 30_000 }, async t => {
  const box = machine(t);
  const options = gateOptions(box);
  assert.equal(options.runnerDeadlineAt > Date.now() + 25 * 60_000, true, 'the fixture gate carries the submit\'s 30-minute captured deadline');
  const own = [await hold(options), await hold(options)];
  const shardLeases = [];
  try {
    assert.deepEqual(own.map(lease => lease.runner.host), ['fixture-a', 'fixture-a'], 'the gate\'s own leases fill fixture-a\'s two browser slots');
    // fixture-a still has 2 free gate slots but none for a browser, so only fixture-b's 2 browser slots are this gate's.
    assert.equal(freeRunnerSlots(box.pool), 6, 'counting gate slots alone offers 6 slots a browser shard cannot all use');
    const free = freeRunnerSlots(box.pool, { browser: true, gui: false, runners: RUNNERS });
    assert.equal(free, 2, 'a browser gate plans only the browser slots runners can still free');
    const lane = [];
    // The gate's own lane holds its first batch until both free browser slots have joined, so they find batches left.
    let joined;
    const bothJoined = new Promise(resolve => { joined = resolve; });
    const runFirst = async files => { lane.push(files); await bothJoined; return { isGreen: true, exitCode: 0, output: '' }; };
    const takeSlot = async (pull, { closed }) => {
      const lease = await takeResource({ ...shardSlotOptions(options, { admitMs: ADMIT_MS, closed }), runnerProvider: () => RUNNERS });
      shardLeases.push(lease.runner.host);
      if (shardLeases.length === free) joined();
      try { return await pull(async () => ({ isGreen: true, exitCode: 0, output: '', executionRunner: lease.runner.host })); }
      finally { lease.release(); }
    };
    const shards = await runProofShards(FILES, { freeSlots: free, batchFiles: 1, retryMs: 50, runFirst, takeSlot });
    const slotShards = shards.filter(shard => shard.run.executionRunner);
    assert.ok(slotShards.length >= 2, `the free browser slots pulled batches (${slotShards.length})`);
    assert.deepEqual([...new Set(slotShards.map(shard => shard.run.executionRunner))], ['fixture-b'],
      'each slot the gate took is on the runner with free browser slots');
    assert.ok(shardLeases.every(host => host === 'fixture-b'), 'no slot request took a browser lease the gate holds itself');
    assert.deepEqual(shards.flatMap(shard => shard.files).sort(), FILES, 'every proof file runs exactly once');
  } finally { for (const lease of own) lease.release(); }
});

test('clause 2: a gate shard that cannot be placed ends RUNNER_WAIT_DEADLINE within its admission window, not the submit\'s 30-minute deadline, and runs on the gate lane [C7]', { timeout: 30_000 }, async t => {
  const box = machine(t);
  const options = gateOptions(box);
  const own = [await hold(options), await hold(options), await hold(options), await hold(options)];
  try {
    assert.deepEqual(own.map(lease => lease.runner.host).sort(), ['fixture-a', 'fixture-a', 'fixture-b', 'fixture-b'], 'the gate holds every browser slot');
    assert.equal(freeRunnerSlots(box.pool, { browser: true, gui: false, runners: RUNNERS }), 0, 'no browser slot is free, so the planner adds no shard');
    const shard = shardSlotOptions(options, { now: 1_000, admitMs: ADMIT_MS });
    assert.equal(shard.runnerDeadlineAt, 1_000 + ADMIT_MS, 'the shard takes its own deadline, never the submit\'s captured one');
    assert.equal(shard.runnerWaitMs, ADMIT_MS);
    assert.equal(shard.runnerOnly, true);
    assert.equal(shard.onWait, undefined);
    assert.equal(shardSlotOptions(options).runnerWaitMs, SHARD_ADMIT_MS, 'production shards wait SHARD_ADMIT_MS');
    // A request made before the slots filled still asks for a slot: its admission must end, not wait on the gate's own leases.
    const lane = [];
    let refusal = null, waitedMs = 0, refused;
    const ended = new Promise(resolve => { refused = resolve; });
    const runFirst = async files => { await ended; lane.push(files); return { isGreen: true, exitCode: 0, output: '' }; };
    const takeSlot = async (pull, { closed }) => {
      if (refusal) throw refusal;
      const started = Date.now();
      try { return await takeResource({ ...shardSlotOptions(options, { admitMs: ADMIT_MS, closed }), runnerProvider: () => RUNNERS }); }
      catch (error) { refusal = error; throw error; }
      finally { waitedMs = Date.now() - started; refused(); }
    };
    const shards = await runProofShards(FILES.slice(0, 2), { freeSlots: 1, batchFiles: 1, retryMs: 10, runFirst, takeSlot });
    assert.equal(refusal?.code, 'RUNNER_WAIT_DEADLINE', `the unplaceable request ends infrastructure-red: ${refusal?.message}`);
    // One admission window plus the item check's one infrastructure retry of the same window, never the submit's 30 minutes.
    assert.ok(waitedMs < 2 * ADMIT_MS + 2_000, `the shard ended in ${waitedMs} ms`);
    assert.deepEqual(lane, [['test/a.test.js'], ['test/b.test.js']], 'the batches no slot took run on the gate\'s own lane');
    assert.deepEqual(shards.map(entry => entry.files), [['test/a.test.js'], ['test/b.test.js']]);
  } finally { for (const lease of own) lease.release(); }
});
