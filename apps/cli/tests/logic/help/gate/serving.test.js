/** A gate-drive job whose hand-off ended or whose item left its serving state ends stale; the dispatcher never admits it [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';
import { withFixtureBoard } from '../../../fixtures/testkit.js';
import { createJob } from '../../../../../../packages/jobs/index.js';
import { jobView } from '../../../../../../packages/jobs/index.js';
import { runGateStages } from '../../../../../../packages/gate/index.js';
import { createGateAdmission } from '../../../../../../packages/drive/index.js';
import { drainLoop } from '../../../../../../packages/drive/index.js';
import { driveOnce } from '../../../../../../packages/drive/index.js';
import { gateDriveJobId } from '../../../../../../packages/drive/index.js';
import { GATE_DRIVE_KIND } from '../../../../../../packages/drive/index.js';
import { recordJobRow } from '../../../../../../packages/drive/index.js';
import { rowSink } from '../../../../../../packages/drive/index.js';
import { drivenHandoffGate } from '../../../../src/io/submit/handoff/worker.js';
import { handoffRefusedResult } from '../../../../src/io/submit/handoff/worker.js';

const STAGES = ['preflight', 'selection', 'cells', 'doctrine', 'static', 'tests'];

/** A repo with one commit, so a gate job has a candidate tree to capture. */
function candidateRepo() {
  const files = privateFixtureFiles('pullboard-serving-repo-');
  runFixtureGit(['-C', files.root, 'init', '-q']);
  files.write('a.txt', 'candidate\n');
  runFixtureGit(['-C', files.root, 'add', '-A']);
  runFixtureGit(['-C', files.root, '-c', 'user.email=s@example.test', '-c', 'user.name=S', 'commit', '-q', '-m', 'candidate']);
  return { repo: files.root, commit: runFixtureGit(['-C', files.root, 'rev-parse', 'HEAD']) };
}

/** Open a fresh real board file and hand it to the body. */
function withBoard(body) {
  const files = privateFixtureFiles('pullboard-serving-board-');
  return withFixtureBoard(join(files.root, 'board.sqlite'), body);
}

/** The steps of one name on a job view, as payloads. */
const steps = (job, name) => job.steps.filter(step => step.name === name).map(step => step.payload);

test('clause 1: a gate-drive job that no longer serves its item ends stale before any transition, marked done [C7]', async () => {
  const { repo, commit } = candidateRepo();
  await withBoard(async board => {
    const id = gateDriveJobId('5e7a1e00-0000-4000-8000-000000004072');
    createJob(board.db, { id, kind: GATE_DRIVE_KIND, item: 7, candidate: commit, base: commit });
    const outcome = await driveOnce(board.db, id, { owner: 'driver-serving', repo, serving: () => false });
    assert.equal(outcome.code, 'GATE_STALE');
    const job = jobView(board.db, id);
    assert.equal(job.step, 'done', 'the job is marked done');
    assert.equal(job.leaseOwner, null, 'its lease is freed');
    assert.equal(steps(job, 'ended')[0].stale, true);
    assert.deepEqual(steps(job, 'captured'), [], 'no transition ran');
  });
});

test('clause 1: a running gate stops at its next renewal tick once its item leaves its serving state [C7]', { timeout: 30_000 }, async () => {
  const { repo, commit } = candidateRepo();
  await withBoard(async board => {
    const db = board.db;
    const id = gateDriveJobId('5e7a1e00-0000-4000-8000-000000004073');
    createJob(db, { id, kind: GATE_DRIVE_KIND, item: 7, candidate: commit, base: commit });
    let skew = 0, served = true, waiters = [];
    const now = () => Date.now() + skew;
    const rows = rowSink(jobView(db, id), row => {
      const answer = recordJobRow(db, row);
      if (row.type === 'ticket') { const due = waiters; waiters = []; for (const resolve of due) resolve(); }
      return answer;
    });
    const tick = () => new Promise(resolve => { waiters.push(resolve); });
    const reached = [];
    const submit = async ctx => {
      await (ctx.runGateStages ?? runGateStages)(STAGES.map(name => ({ name, run: async signal => {
        reached.push(name);
        if (name !== 'tests') return { name };
        // The item is withdrawn mid-tests; the drive's next serving check, 30 s on, ends the gate.
        served = false;
        for (let n = 0; n < 4 && !signal?.aborted; n += 1) { skew += 15_000; await tick(); }
        return new Promise(() => {});
      } })));
      ctx.submissionResult.value = { commit };
    };
    const gate = drivenHandoffGate({}, { item: 7 }, { waitInventory: async () => null, submit });
    const last = await drainLoop(rows, id, { owner: 'driver-serving', repo, gate, intervalMs: 5, stallCheckMs: 25, stalled: handoffRefusedResult, now, serving: () => served });
    assert.equal(last.code, 'GATE_STALE', 'the drive loop stops on the stale gate');
    const job = jobView(db, id);
    assert.equal(job.step, 'done');
    assert.equal(steps(job, 'ended')[0].stale, true);
    assert.deepEqual(steps(job, 'collected'), [], 'the stale gate records no result');
    assert.ok(reached.includes('tests'));
  });
});

test('clause 1: the dispatcher never admits a launch whose hand-off no longer serves its item [C7]', async () => {
  await withBoard(board => {
    const files = privateFixtureFiles('pullboard-serving-launch-');
    const admission = createGateAdmission({ openBoard: () => board, closeBoard: () => {}, serving: () => false });
    // onBoard opens <commonDir>/pullboard/board.sqlite only when it exists; give the launch a real one.
    files.write('pullboard/board.sqlite', '');
    assert.throws(() => admission.admit({ job: 'stale-launch', commonDir: files.root, directory: files.root }, { owner: 'gate-driver:stale', relaunches: 0 }),
      error => error.code === 'GATE_STALE');
    assert.equal(jobView(board.db, gateDriveJobId('stale-launch')), null, 'no drive job was admitted');
  });
});
