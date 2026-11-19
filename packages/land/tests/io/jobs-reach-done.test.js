/** A failed landing run and a finish sequence stopped by LAND_PROOF_NOT_GREEN each end with a failed step and done [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { driveLanding } from '../../../drive/index.js';
import { finishSequence } from '../../index.js';

/** The job's step name, lease owner and the code of its failed step. */
const ended = (db, id) => {
  const view = jobView(db, id);
  return { step: view.step, owner: view.leaseOwner, failed: view.steps.find(step => step.name === 'failed')?.payload.code ?? null };
};

test('land.jobs.throw-ends-done: a landing run that throws ends with a failed step and done, with no owner [C7]', async t => {
  const db = cellBoard(t, ':memory:').db;
  await assert.rejects(driveLanding(db, { owner: 'lander', id: 'land:run', run: async () => { throw Object.assign(new Error('boom'), { code: 'LAND_BOOM' }); } }), /boom/);
  assert.deepEqual(ended(db, 'land:run'), { step: 'done', owner: null, failed: 'LAND_BOOM' });
});

test('land.jobs.stall-ends-done: a landing run that stalls ends with a failed step and done, with no owner [C7]', async t => {
  const db = cellBoard(t, ':memory:').db;
  await driveLanding(db, { owner: 'lander', id: 'land:stall', run: async () => ({ stalled: true, stallDescription: 'no progress' }) });
  assert.deepEqual(ended(db, 'land:stall'), { step: 'done', owner: null, failed: 'LAND_STALLED' });
});

test('land.jobs.proof-not-green-stays-done: a finish sequence stopped by LAND_PROOF_NOT_GREEN ends with a failed step and done, and stays so when resumed [C7]', async t => {
  const repo = cellRepo(t);
  repo.put('feature.txt', 'candidate\n');
  const candidate = repo.commitAll();
  const db = cellBoard(t, ':memory:').db;
  createJob(db, { id: 'land:1', kind: 'landing', item: 1, candidate, base: repo.commit, now: 1 });
  const steps = { select: () => ({ items: [1] }), compose: () => ({ candidate, base: repo.commit }), prove: () => ({ verdict: 'red', code: 'TEST_FAILURE' }),
    merge: () => assert.fail('nothing merges on a red proof'), record: () => ({}), publish: () => ({}) };
  const first = await finishSequence(db, 'land:1', { owner: 'a', repo: repo.root, steps });
  assert.equal(first.code, 'LAND_PROOF_NOT_GREEN');
  assert.deepEqual(ended(db, 'land:1'), { step: 'done', owner: null, failed: 'LAND_PROOF_NOT_GREEN' });
  const again = await finishSequence(db, 'land:1', { owner: 'b', repo: repo.root, steps });
  assert.equal(again.code, 'LAND_PROOF_NOT_GREEN');
  assert.deepEqual(ended(db, 'land:1'), { step: 'done', owner: null, failed: 'LAND_PROOF_NOT_GREEN' });
});
