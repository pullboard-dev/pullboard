/**
 * Repro, 8 Nov: one shard per free slot let a single gate start 13 runner-controller processes on the coordinator;
 * at load 59 the confirming probes took 100-200 s and marked every idle runner unresponsive, stopping all gates. The
 * invariant: one gate never runs more than 3 runner-controllers at once, however many slots are free, and every proof
 * file still runs exactly once [C7]. Fails on cc0a573570^ (13 at once); passes after cc0a573570 and b2da9f9484.
 *
 * Each lane's run is a real child process standing in for its runner-controller; the slot pool is a local fixture
 * with 13 free slots, as the coordinator's was.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  from,
  guardProcesses,
  hopCheck,
  scratch,
  within,
} from './kit.js';

const { runProofShards } = await from('packages/gate/src/io/shards/proof.js');

/** The free runner slots the coordinator had when one gate opened 13 controllers. */
const FREE_SLOTS = 13;
/** The most controllers one gate may run at once: its own lane and two slot lanes. */
const MOST_CONTROLLERS = 3;

guardProcesses();

test('one gate never runs more than 3 runner-controllers at once with 13 free slots, and runs every file once [C7]', { timeout: 120_000 }, async () => {
  const dir = await scratch('proof-lanes');
  const files = Array.from({ length: 40 }, (_, index) => `test/hop-${String(index).padStart(2, '0')}.test.js`);
  const ran = [];
  let live = 0, most = 0;
  /** Run one batch as a real controller process on a slot, counting how many run at once. */
  const controller = async batch => {
    live += 1;
    most = Math.max(most, live);
    try {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], { cwd: dir, stdio: 'ignore', env: { PATH: process.env.PATH, HOP_SCRATCH: dir } });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
      ran.push(...batch);
      return { isGreen: true, output: `ok ${batch.length}\n`, files: batch };
    } finally { live -= 1; }
  };
  let free = FREE_SLOTS;
  /** Take one of the fixture pool's free slots, run the lane on it and give it back; a full pool answers at once. */
  const takeSlot = async lane => {
    if (free < 1) throw Object.assign(new Error('no free slot'), { code: 'RUNNER_UNAVAILABLE' });
    free -= 1;
    try { await lane(controller); } finally { free += 1; }
  };

  await hopCheck('proof-lanes', async () => {
    const started = performance.now();
    const batches = await runProofShards(files, { freeSlots: FREE_SLOTS, runFirst: controller, takeSlot, retryMs: 20 });
    const ms = performance.now() - started;
    const measured = { ms, measured: `at most ${most} controllers at once for ${batches?.length ?? 0} batches with ${FREE_SLOTS} free slots` };
    within(most <= MOST_CONTROLLERS, `one gate runs at most ${MOST_CONTROLLERS} runner-controllers at once`, measured);
    assert.deepEqual([...ran].sort(), [...files].sort(), 'every proof file ran exactly once');
    return measured;
  });
});
