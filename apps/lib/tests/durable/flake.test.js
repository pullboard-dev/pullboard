/** Durable gate 23: flake diagnostics are a job that runs after the verdict, off the critical path [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { openBoard } from '../../index.js';
import { closeBoard } from '../../index.js';
import { createJob } from '../../../../packages/jobs/index.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { reclaimLapsed } from '../../../../packages/jobs/index.js';
import { takeJob } from '../../../../packages/jobs/index.js';
import { writeStep } from '../../../../packages/jobs/index.js';
import { LEASE_MS } from '../../../../packages/jobs/index.js';
import { treeOf } from '../../../../packages/pin/index.js';
import { driveFlakeDiagnose } from '../../../../packages/drive/index.js';
import { driveOnce } from '../../../../packages/drive/index.js';
import { jobbedFlakeObserver } from '../../../../packages/drive/index.js';
import { flakeDiagnoseKey } from '../../../../packages/drive/index.js';
import { flakeDiagnosesFor } from '../../../../packages/drive/index.js';
import { queueFlakeDiagnoses } from '../../../../packages/drive/index.js';
import { FLAKE_DIAGNOSE_KIND } from '../../../../packages/drive/index.js';

/** A one-commit repo; returns the commit and its tree id. */
function candidateRepo() {
  const files = privateFixtureFiles('pullboard-flake23-repo-');
  const repo = files.root;
  runFixtureGit(['-C', repo, 'init', '-q']);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'flake@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Flake Test']);
  files.write('a.test.js', 'case\n');
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'candidate']);
  const commit = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  return { repo, commit, tree: treeOf(repo, commit) };
}

/** Open a fresh real board file and hand its SQLite handle to the body. */
async function withBoard(body) {
  const board = openBoard(':memory:');
  try { return await body(board.db); } finally { closeBoard(board); }
}

/** A transport that must never be used: judging a collected job sends nothing to a runner. */
const noTransport = { connect() { throw new Error('the verdict transition used a runner'); } };

/** Seed a gate job, held by `driver-a`, whose shards are collected with the given exit statuses. */
function collectedGate(db, { id, item, commit, tree, statuses, now }) {
  createJob(db, { id, kind: 'gate', item, candidate: commit, now });
  takeJob(db, id, 'driver-a', { now });
  writeStep(db, id, 'captured', { tree, tooling: tree, pinned: false, base: null }, { now });
  const shards = Object.keys(statuses).map(shard => ({ shard, command: 'run the project tests' }));
  writeStep(db, id, 'running', { runner: { host: 'runner-a' }, shards }, { now });
  shards.forEach(({ shard }, seq) => writeStep(db, id, 'shard.done', { shard, status: statuses[shard], digest: 'd'.repeat(64) }, { seq, now }));
  writeStep(db, id, 'collected', { shards: Object.fromEntries(Object.entries(statuses).map(([shard, status]) => [shard, { status, digest: 'd'.repeat(64) }])) }, { now });
}

test('lib.durable-flake.a-red-gate-records-its-verdict: clause 1: a red gate records its verdict and frees its worker first; flake-diagnose jobs keyed by (tree, file, case) run later and attach their result to the item [C7]', async () => {
  const { commit, tree } = candidateRepo();
  await withBoard(async (db) => {
    const now = 50_000;
    collectedGate(db, { id: 'g1', item: 77, commit, tree, statuses: { s0: 0, s1: 1 }, now });
    const failing = [{ file: 'test/a.test.js', case: 'adds' }, { file: 'test/a.test.js', case: 'adds' }, { file: 'test/b.test.js', case: 'parses' }];
    const diagnosed = [];
    const diagnose = async target => { diagnosed.push(target); return { flaky: target.case === 'adds', reruns: 3 }; };

    const verdict = await driveOnce(db, 'g1', { owner: 'driver-a', transport: noTransport, failures: () => failing, now: () => now });
    assert.equal(verdict.transition, 'verdict');
    assert.equal(verdict.job.steps.find(s => s.name === 'verdict').payload.verdict, 'red');
    assert.equal(diagnosed.length, 0, 'no diagnostic ran inside the gate driver');
    assert.equal(verdict.job.leaseOwner, null, 'the verdict frees the gate worker\'s lease');
    assert.deepEqual(reclaimLapsed(db, { now: now + 3 * LEASE_MS }).filter(job => job.id === 'g1'), [], 'a judged gate never reads as stalled');

    const jobs = jobsOf(db, { kind: FLAKE_DIAGNOSE_KIND, item: 77 });
    assert.deepEqual(jobs.map(job => job.id).sort(), [flakeDiagnoseKey(tree, 'test/a.test.js', 'adds'), flakeDiagnoseKey(tree, 'test/b.test.js', 'parses')].sort(),
      'one job per distinct (tree, file, case)');
    assert.ok(jobs.every(job => job.kind === 'flake-diagnose' && job.step === 'queued' && job.leaseOwner === null), 'the jobs wait for any driver');
    const order = db.prepare('SELECT job_step_job AS job, job_step_name AS name FROM job_step WHERE job_step_name IN (\'verdict\', \'queued\') ORDER BY job_step_id').all();
    assert.deepEqual(order.map(row => row.name), ['verdict', 'queued', 'queued'], 'the verdict is written before any diagnostic is queued');

    const attached = [];
    for (const job of jobs) {
      const done = await driveFlakeDiagnose(db, job.id, { owner: 'driver-b', diagnose, attach: info => { attached.push(info); }, now: () => now + 10 });
      assert.equal(done.transition, 'attached');
      assert.equal(done.job.leaseOwner, null, 'a finished diagnostic frees its lease');
    }
    assert.deepEqual(diagnosed.map(t => [t.tree, t.file, t.case, t.item]).sort(), [[tree, 'test/a.test.js', 'adds', 77], [tree, 'test/b.test.js', 'parses', 77]]);
    assert.deepEqual(attached.map(a => a.item), [77, 77], 'each result is attached to the gate\'s item');
    const results = flakeDiagnosesFor(db, 77).map(d => [d.file, d.case, d.tree, d.gate, d.result.flaky]).sort();
    assert.deepEqual(results, [['test/a.test.js', 'adds', tree, 'g1', true], ['test/b.test.js', 'parses', tree, 'g1', false]]);

    const again = await driveFlakeDiagnose(db, jobs[0].id, { owner: 'driver-c', diagnose, now: () => now + 20 });
    assert.equal(again.transition, null, 'an attached diagnostic is terminal');
    assert.equal(diagnosed.length, 2, 'a finished diagnostic never runs again');

    const requeued = queueFlakeDiagnoses(db, { id: 'g2', item: 77, candidate: commit }, tree, failing, { now: now + 30 });
    assert.deepEqual(requeued.sort(), jobs.map(job => job.id).sort(), 'a second red gate on the same tree reuses the keyed jobs');
    assert.equal(jobsOf(db, { kind: FLAKE_DIAGNOSE_KIND }).length, 2);
    assert.equal(jobView(db, jobs[0].id).step, 'attached', 'requeueing never resets a finished diagnostic');
  });
});

test('lib.durable-flake.a-green-gate-queues-no-flake: clause 1: a green gate queues no flake diagnostic, and a diagnostic held by a live driver is left alone [C7]', async () => {
  const { commit, tree } = candidateRepo();
  await withBoard(async (db) => {
    collectedGate(db, { id: 'g3', item: 78, commit, tree, statuses: { s0: 0 }, now: 1000 });
    const failures = () => [{ file: 'test/a.test.js', case: 'adds' }];
    const green = await driveOnce(db, 'g3', { owner: 'driver-a', transport: noTransport, failures, now: () => 1000 });
    assert.equal(green.job.steps.find(s => s.name === 'verdict').payload.verdict, 'green');
    assert.deepEqual(jobsOf(db, { kind: FLAKE_DIAGNOSE_KIND }), [], 'only a red verdict queues diagnostics');

    const [id] = queueFlakeDiagnoses(db, { id: 'g4', item: 78, candidate: commit }, tree, failures(), { now: 2000 });
    takeJob(db, id, 'driver-x', { now: 2000 });
    let ran = 0;
    const held = await driveFlakeDiagnose(db, id, { owner: 'driver-y', diagnose: () => { ran += 1; }, now: () => 2000 + LEASE_MS - 1 });
    assert.equal(held.code, 'JOB_LEASED');
    assert.equal(ran, 0);
    const resumed = await driveFlakeDiagnose(db, id, { owner: 'driver-y', diagnose: () => { ran += 1; return { flaky: false }; }, now: () => 2000 + LEASE_MS + 1 });
    assert.equal(resumed.transition, 'attached', 'a lapsed diagnostic is resumed by any driver');
    assert.deepEqual(flakeDiagnosesFor(db, 78).map(d => d.result), [{ flaky: false }]);
  });
});

test('lib.durable-flake.the-submit-gate-s-flake-observer: clause 1: the submit gate\'s flake observer runs as flake-diagnose jobs keyed by (tree, file, case), each case\'s observation attached to the item [C7]', async () => {
  const { repo, commit, tree } = candidateRepo();
  await withBoard(async (db) => {
    let open = false;
    const withDb = async work => { open = true; try { return await work(db); } finally { open = false; } };
    let observed = 0;
    const observe = Object.assign(async run => {
      observed += 1;
      assert.equal(open, false, 'the board is not held open while the diagnostic runs');
      run.flakeDiagnostics = { wallMs: 1, observations: [{ id: 'o1', classification: 'flake', file: 'test/a.test.js', name: 'adds', paired: true, recorded: true }] };
    }, { main: 'main-commit', recordRun: () => {} });
    const cases = () => [{ file: 'test/a.test.js', case: 'adds' }, { file: 'test/b.test.js', case: 'parses' }];
    const wrapped = jobbedFlakeObserver(observe, { withDb, gate: { id: 'submit:90', item: 90, candidate: commit }, repo, owner: 'seat-1', cases });
    assert.equal(wrapped.main, 'main-commit', 'the wrapped observer keeps the pinned main the gate reads');

    await wrapped({ isGreen: false, output: '' }, { root: repo });
    assert.equal(observed, 1, 'one observer run diagnoses every case of the red run');
    const attached = flakeDiagnosesFor(db, 90).map(d => [d.job, d.file, d.case, d.result.classification]).sort();
    assert.deepEqual(attached, [[flakeDiagnoseKey(tree, 'test/a.test.js', 'adds'), 'test/a.test.js', 'adds', 'flake'],
      [flakeDiagnoseKey(tree, 'test/b.test.js', 'parses'), 'test/b.test.js', 'parses', 'unclassified']].sort());
    assert.ok(jobsOf(db, { kind: FLAKE_DIAGNOSE_KIND, item: 90 }).every(job => job.leaseOwner === null), 'finished diagnostics hold no lease');

    await wrapped({ isGreen: false, output: '' }, { root: repo });
    assert.equal(observed, 1, 'a red rerun on the same tree reuses the attached diagnostics');
  });
});
