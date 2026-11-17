/** With gate.reofferInfraEnd on, a gate job that ends GATE_JOB_NO_PROGRESS is offered once more for its commit, once [C7,#9633]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { LEASE_MS } from '../../../jobs/index.js';
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { endDeadGateJobs } from '../../index.js';
import { lapsedGateJobs } from '../../index.js';
import { GATE_JOB_NO_PROGRESS_MS } from '../../index.js';

/** A gate job offered at 1000 for item 7 at commit abc, taken by a runner that then goes quiet. */
function quietGate(db, id = 'gate:7:abc:one') {
  createJob(db, { id, kind: 'gate', item: 7, candidate: 'abc', base: 'main1', now: 1000 });
  writeStep(db, id, 'offered', { needs: ['node22'], priority: 'gate', request: { run: ['node'] } }, { now: 1000 });
  takeJob(db, id, 'runner-1', { now: 1000 });
}

/** Run the dead-job pass at a time long past the lease and the no-progress limit. */
function pass(t, { reofferInfraEnd, active } = {}, setup = quietGate) {
  const board = fixtureBoard(t);
  setup(board.db);
  const later = 1000 + Math.max(LEASE_MS, GATE_JOB_NO_PROGRESS_MS) + 1;
  const run = at => endDeadGateJobs(board.db, lapsedGateJobs(board.db, { now: at }), { owner: 'fallback', now: at, active, reofferInfraEnd });
  const gates = () => board.db.prepare("SELECT job_id AS id, job_step AS step FROM job WHERE job_kind = 'gate' ORDER BY job_id").all();
  return { board, later, run, gates };
}

test('drive.reoffer.with-gate-reofferinfraend-on-a: clause 1: with gate.reofferInfraEnd on, a gate job that ends GATE_JOB_NO_PROGRESS is offered once more for the same item and commit [C7,#9633]', t => {
  const f = pass(t, { reofferInfraEnd: true });
  assert.deepEqual(f.run(f.later).map(row => row.ended), ['infrastructure']);
  const again = jobView(f.board.db, 'gate:7:abc:one:reoffer');
  assert.deepEqual([again.step, again.item, again.candidate, again.base], ['offered', 7, 'abc', 'main1']);
  assert.deepEqual(again.steps.find(step => step.name === 'offered').payload.request, { run: ['node'] });
  assert.equal(again.leaseOwner, null, 'the new job is open for any runner');
  const old = jobView(f.board.db, 'gate:7:abc:one');
  assert.equal(old.step, 'done');
  assert.deepEqual(old.steps.find(step => step.name === 'reoffered').payload, { job: 'gate:7:abc:one:reoffer' });
});

test('drive.reoffer.a-gate-job-whose-item: clause 2: a gate job whose item left the commit, a gate job that ended red, and a run with the setting off are not offered again [C7,#9633]', t => {
  const stale = pass(t, { reofferInfraEnd: true, active: () => false });
  assert.deepEqual(stale.run(stale.later).map(row => row.ended), ['stale']);
  assert.deepEqual(stale.gates().map(row => row.id), ['gate:7:abc:one'], 'a stale job is not re-offered');
  const red = pass(t, { reofferInfraEnd: true }, db => {
    quietGate(db);
    writeStep(db, 'gate:7:abc:one', 'result', { red: true }, { now: 1500 });
    db.prepare("UPDATE job SET job_step = 'done', job_lease_owner = NULL, job_lease_until = 0 WHERE job_id = 'gate:7:abc:one'").run();
  });
  assert.deepEqual(red.run(red.later), [], 'a job at its red verdict is never ended as infrastructure');
  assert.deepEqual(red.gates().map(row => row.id), ['gate:7:abc:one'], 'a real red is not re-offered');
  const off = pass(t, {});
  assert.deepEqual(off.run(off.later).map(row => row.ended), ['infrastructure']);
  assert.deepEqual(off.gates().map(row => row.id), ['gate:7:abc:one'], 'with the setting off nothing is re-offered');
});

test('drive.reoffer.a-re-offered-gate-job: clause 3: a re-offered gate job that ends GATE_JOB_NO_PROGRESS too is not offered a second time for the commit [C7,#9633]', t => {
  const f = pass(t, { reofferInfraEnd: true });
  f.run(f.later);
  const second = f.later + GATE_JOB_NO_PROGRESS_MS + LEASE_MS + 1;
  takeJob(f.board.db, 'gate:7:abc:one:reoffer', 'runner-2', { now: f.later });
  assert.deepEqual(f.run(second).map(row => row.ended), ['infrastructure']);
  assert.deepEqual(f.gates().map(row => `${row.id}:${row.step}`), ['gate:7:abc:one:done', 'gate:7:abc:one:reoffer:done'], 'no third job');
});
