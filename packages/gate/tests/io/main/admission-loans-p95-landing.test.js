/** @pullboard-test-input packages/gate/src/io/browser/admission.js packages/gate/src/io/run/tests.js */
/** @pullboard-test-timing */
/** Four concurrent landing runs keep process lifetime under twice standalone; one mode per file so each finishes under 60 s [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureFileInflation } from '../../fixtures/p95.js';

test('gate.io-main-admission-loans-p95-landing.four-concurrent-runs-start-only-token: four concurrent runs start only token-owned file processes and keep p95 below twice standalone [C7]', async t => {
  for (const mode of ['landing']) await t.test(mode, async scope => {
    const measurement = await measureFileInflation(scope, mode);
    const { samples, runs, standalone, standaloneAfter, ...summary } = measurement; // the rows are long; the summary keeps a red's numbers in a short log
    scope.diagnostic('P95_MEASUREMENT=' + JSON.stringify({ ...summary, worstRatios: samples.map(row => Math.round(row.ratio * 100) / 100).sort((x, y) => y - x).slice(0, 4) }));
    assert.equal(measurement.peakConcurrentRuns, 4, 'all four actual private gate leases overlapped');
    await scope.test('only token-owned file processes start', () => {
      assert.ok(measurement.peakFileProcesses <= measurement.cores,
        `a two-token machine must not spawn files that wait for a token; saw ${measurement.peakFileProcesses}`);
    });
    await scope.test('p95 stays below twice standalone', () => {
      assert.ok(measurement.p95 < 2, `p95 process-lifetime ratio ${measurement.p95} must be below2x standalone`); // budget: #1091 requires p95<2x under four concurrent runs.
    });
  });
});
