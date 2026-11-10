/** Registered SSH runner execution stays inside a committed, secret-free worker checkout [C7]. */
/** Scenario partition: original case bytes and deadlines remain unchanged. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { PAIRED_RERUN_FIXTURE } from '../../../tests/fixtures/runner/paired/tools.js';
import { assertAttemptDeadlineReset } from '../../../tests/fixtures/runner/paired/rerun.js';
import { assertRedispatchDeadlineAccounting } from '../../../tests/fixtures/runner/paired/rerun.js';
import { runPairedRerun } from '../../../tests/fixtures/runner/paired/rerun.js';
import { startRunnerCpuStandIn } from '../../../tests/fixtures/runner/paired/rerun.js';
import { assertFixtureGroupEpermControls } from '../../../tests/fixtures/runner/group.js';
import { cleanupFixtureChildren } from '../../../tests/fixtures/child.js';
import { cleanupToolingSnapshots } from '../../../tests/fixtures/runner/tooling.js';

after(cleanupFixtureChildren);
after(cleanupToolingSnapshots);

test('the runner round trip deadline holds under a loaded test machine and still catches a stuck phase [C7]',
  { timeout: 660_000, cpuLoad: true }, async t => { // budget: five real paired attempts plus a bounded held phase, below the file hang ceiling.
    await assertAttemptDeadlineReset(PAIRED_RERUN_FIXTURE);
    await assertRedispatchDeadlineAccounting(PAIRED_RERUN_FIXTURE);
    assertFixtureGroupEpermControls();
    const busy = await startRunnerCpuStandIn();
    t.after(busy.stop);
    assert.equal(busy.count, Math.max(1, Math.floor(busy.cores / 2)), 'the fixture owns one busy child for each half-core slot');
    try {
      for (let run = 1; run <= 5; run++) {
        await t.test(`paired rerun ${run} of 5 [C7]`, async child => {
          const observation = await runPairedRerun(child, 'paired-no-load', PAIRED_RERUN_FIXTURE, { cpuLoad: busy });
          assert.equal(observation.paired?.green, true, 'the paired runner rerun makes progress and passes');
          assert.equal(observation.classification, 'unclassified', 'without the paired host load, a green run is not called a flake');
          busy.assertAlive();
        });
      }
      t.diagnostic(JSON.stringify({ cpuStandIn: busy.count, pids: busy.pids, cores: busy.cores,
        loadBefore: Number(busy.loadBefore.toFixed(1)), loadDuring: Number(busy.loadAfter().toFixed(1)), pairedRuns: 5, cpu: busy.report.cpuSnapshots }));
      await t.test('a permanently held result return remains a named bounded failure [C7]', async child => {
        await runPairedRerun(child, 'paired-no-load', PAIRED_RERUN_FIXTURE, { hold: 'return' });
      });
    } finally {
      await busy.stop();
    }
  });
