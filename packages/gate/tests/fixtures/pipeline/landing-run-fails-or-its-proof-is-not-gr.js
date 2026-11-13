/**
 * Invariant: a landing run that fails, stalls or whose proof is not green ends failed with its lease freed, so nothing
 * lists it as live or lapsed again and the next landing can start [C7].
 * Repro: a failed run once kept its lease-freed row open ("lease-freed but never done"), so status read a landing that
 * was over. The run is one job row driven by driveLanding; a green run finishes `done`, a failed one writes `failed`.
 * Runs on a real SQLite board with the production job store.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hopCheck } from './kit.js';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { driveLanding } from '../../../../drive/index.js';
import { jobView } from '../../../../jobs/index.js';
import { leasedJobs } from '../../../../jobs/index.js';
import { reclaimLapsed } from '../../../../jobs/index.js';

const KIND = 'landing-run';
/** Long enough after any lease that a still-held row would show as lapsed. */
const LATER = 24 * 60 * 60_000;

/** Assert a run's row is over: failed, nobody holds it, and no scan lists it live or lapsed. */
function assertEnded(db, id, code) {
  const view = jobView(db, id);
  assert.equal(view.step, 'done', 'a failed run ends done (#4058), so nothing lists it as live');
  assert.ok(view.steps.some(step => step.name === 'failed'), 'the run records its failed step');
  assert.equal(view.steps.find(step => step.name === 'failed').payload.code, code);
  assert.equal(view.leaseOwner, null, 'its lease is freed');
  assert.deepEqual(reclaimLapsed(db, { now: Date.now() + LATER }).filter(job => job.id === id), [], 'it is never listed as lapsed');
  assert.deepEqual(leasedJobs(db, { kind: KIND }).map(job => job.id), [], 'it is never listed as live');
}

test('a landing run that throws ends failed with its lease freed, and the next landing starts [C7]', async t => {
  await hopCheck('landing-run-throws', async () => {
    const { db } = cellBoard(t, ':memory:');
    await assert.rejects(driveLanding(db, { owner: 'lander-1', id: 'land:run:thrown', run: async () => { throw Object.assign(new Error('merge refused'), { code: 'LAND_MERGE' }); } }), /merge refused/u);
    assertEnded(db, 'land:run:thrown', 'LAND_MERGE');
    const next = await driveLanding(db, { owner: 'lander-2', id: 'land:run:next', run: async () => ({ landed: [] }) });
    assert.deepEqual(next, { landed: [] });
    assert.equal(jobView(db, 'land:run:next').step, 'done', 'a green run finishes done');
    return { measured: 'failed LAND_MERGE, lease freed, next landing done' };
  });
});

test('a landing run whose batch stalled, so its proof is not green, ends failed with its lease freed [C7]', async t => {
  await hopCheck('landing-run-stalled', async () => {
    const { db } = cellBoard(t, ':memory:');
    await driveLanding(db, { owner: 'lander-1', id: 'land:run:stalled', run: async () => ({ stalled: true, stallDescription: 'proof red', batch: { id: 'b1', state: 'failed' }, landed: [] }) });
    assertEnded(db, 'land:run:stalled', 'LAND_STALLED');
    assert.equal(jobView(db, 'land:run:stalled').steps.find(step => step.name === 'failed').payload.message, 'proof red');
    return { measured: 'failed LAND_STALLED, lease freed' };
  });
});
