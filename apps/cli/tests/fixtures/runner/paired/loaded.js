/** One paired runner rerun under the half-core CPU stand-in, shared by the five per-run deadline journeys [C7]. */
import assert from 'node:assert/strict';
import { PAIRED_RERUN_FIXTURE } from './tools.js';
import { runPairedRerun } from './rerun.js';
import { startRunnerCpuStandIn } from './rerun.js';

/**
 * Run one paired rerun on a loaded test machine and assert it makes progress and passes.
 * Why a helper: the five runs were one file past its 120 s budget; each now runs in a file of its own with this body.
 *
 * @param {import('node:test').TestContext} t
 * @param {number} run - Which of the five paired reruns this is, for the diagnostic.
 */
export async function assertLoadedPairedRerun(t, run) {
  const busy = await startRunnerCpuStandIn();
  t.after(busy.stop);
  assert.equal(busy.count, Math.max(1, Math.floor(busy.cores / 2)), 'the fixture owns one busy child for each half-core slot');
  try {
    const observation = await runPairedRerun(t, 'paired-no-load', PAIRED_RERUN_FIXTURE, { cpuLoad: busy });
    assert.equal(observation.paired?.green, true, 'the paired runner rerun makes progress and passes');
    assert.equal(observation.classification, 'unclassified', 'without the paired host load, a green run is not called a flake');
    busy.assertAlive();
    t.diagnostic(JSON.stringify({ run, cpuStandIn: busy.count, pids: busy.pids, cores: busy.cores,
      loadBefore: Number(busy.loadBefore.toFixed(1)), loadDuring: Number(busy.loadAfter().toFixed(1)), cpu: busy.report.cpuSnapshots }));
  } finally {
    await busy.stop();
  }
}
