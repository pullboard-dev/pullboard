/** @pullboard-test-input apps/cli/pullboard.js packages/blueprints/src/io/main.js packages/blueprints/src/io/report.js packages/blueprints/src/io/set.js apps/cli/tests/fixtures/blueprint/pilot-record.json */
/**
 * The record of the in-process journey pilot (#8058, U149): both versions' runtimes and the share of seeded faults each
 * catches, kept beside the tools that measured them. The record is re-derivable (a driver file named pilot-run.<fault>.<leg>.<n>.test.js runs one leg through pilot-driver.js); this test keeps
 * it honest: every seeded fault has a row, every fault text still exists in its file, and each published number is
 * the count its rows give [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAULTS } from '../../tests/fixtures/blueprint/pilot-faults.js';
import { faultStillApplies } from '../../tests/fixtures/blueprint/pilot.js';
import { readPilotRecord } from '../../tests/fixtures/blueprint/pilot.js';
import { catchRates } from '../../tests/fixtures/blueprint/pilot.js';
import { medianRuntimes } from '../../tests/fixtures/blueprint/pilot.js';

const RECORD = readPilotRecord();

test('clause 3: every seeded fault still applies to its file, and the record has a row for each [C7]', () => {
  for (const fault of FAULTS) {
    assert.ok(faultStillApplies(fault), `${fault.id}: its text is still in ${fault.file}; re-seed the fault and re-run the pilot`);
  }
  assert.deepEqual(RECORD.rows.map((row) => row.id), FAULTS.map((fault) => fault.id), 'one row per seeded fault, in order');
});

test('clause 3: the published runtimes and catch counts are the ones the recorded runs give [C7]', () => {
  assert.deepEqual(RECORD.runtimesMs, medianRuntimes(RECORD.baselineRunsMs), 'median of the unmutated runs');
  assert.deepEqual(RECORD.catches, catchRates(RECORD.rows), 'counts derived from the per-fault rows');
  for (const leg of ['real', 'inprocess', 'contract', 'parity']) assert.ok(RECORD.runtimesMs[leg] > 0, `${leg} runtime is recorded`);
  // Each round ran both versions at once, so a round shares one load; the speed-up is the middle ratio of the rounds where the real version finished.
  const ratios = RECORD.pairs.filter((pair) => pair.realFinished).map((pair) => pair.realMs / pair.inprocessMs).sort((a, b) => a - b);
  assert.equal(RECORD.speedUp, Math.round(ratios[Math.floor(ratios.length / 2)] * 10) / 10, 'speed-up is the middle paired ratio');
  assert.ok(RECORD.pairs.some((pair) => !pair.realFinished), 'the rounds where the real version hit the 540 s stop are kept, as lower bounds');
});
