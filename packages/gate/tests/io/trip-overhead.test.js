import test from 'node:test';
import assert from 'node:assert/strict';
import { tripOverheadMs } from '../../index.js';
import { tripOverheadReport } from '../../index.js';

/** A runner receipt as settleReceipt records it: 2 s admission, 3 s setup, 40 s run of which tests ran 38 s, 1 s evidence. */
const trip = { at: '2026-11-15T20:00:00.000Z', kind: 'submit', waitMs: 90_000, admissionMs: 2000, setupMs: 3000, runMs: 40_000, evidenceMs: 1000,
  slot: { kind: 'runner', reason: 'r' }, runner: { id: 'studio', kind: 'pull' },
  executionPhases: { version: 1, prepareMs: 0, capacityWaitMs: 0, sourceMs: 0, dependenciesMs: 0, commandMs: 38_000, cleanupMs: 0, totalMs: 38_000 } };

test('clause 1: a runner receipt records its per-trip overhead in ms, excluding the slot wait and the test time [C7]', () => {
  assert.equal(tripOverheadMs(trip), 8000);
  assert.equal(tripOverheadMs({ ...trip, slot: { kind: 'ordinary', reason: 'r' } }), null, 'a local run has no trip');
  assert.equal(tripOverheadMs({ ...trip, executionPhases: null }), null, 'no executor phases, no split');
});

test('clause 2: a recorded overhead above the budget is reported with the runner and trip named, and only then [C7]', () => {
  const rows = [{ ...trip, tripOverheadMs: 8000 }, { ...trip, runner: { id: 'mini' }, at: '2026-11-15T21:00:00.000Z', tripOverheadMs: 12_500 }];
  const lines = tripOverheadReport(rows, 10_000);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /runner mini trip submit ending 2026-11-15T21:00:00\.000Z: 12\.50s outside tests, 2\.50s over the 10\.00s budget \(report only\)/u);
  assert.deepEqual(tripOverheadReport(rows, 20_000), []);
});
