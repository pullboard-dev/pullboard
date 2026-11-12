/**
 * A gate drive that renews its lease with no step is ended, retried once, ended as infrastructure, and shouted Stuck;
 * one whose tests section reports progress is never ended [C7].
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  fixtureAdd,
  withFixtureBoard,
} from '../../tests/fixtures/testkit.js';
import {
  createJob,
  jobView,
  takeJob,
  writeStep,
} from '../../../../packages/jobs/index.js';
import {
  progressingWait,
  runGateStages,
  whileGateRuns,
} from '../../../../packages/gate/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { INFRASTRUCTURE_CODES } from '../../../../packages/store/index.js';
import {
  drainLoop,
  gateDriveJobId,
  GATE_DRIVE_KIND,
  GATE_STALL_MS,
  GATE_STALL_RETRIES,
  recordJobRow,
  rowSink,
} from '../../../../packages/drive/index.js';
import {
  drivenHandoffGate,
  handoffRefusedResult,
} from '../../src/io/submit/handoff/worker.js';

/** Canonical Submit's own stage names, in its order (durable-b0 reads them from its source). */
const STAGES = ['preflight', 'selection', 'cells', 'doctrine', 'static', 'tests'];
/** A short stall bound so a hung section is measured in fractions of a second; production uses GATE_STALL_MS. */
const STALL_MS = 400;
const CHECK_MS = 25;

/** A repo with one commit, so the gate job has a candidate tree to capture. */
function candidateRepo() {
  const files = privateFixtureFiles('pullboard-stall-repo-');
  runFixtureGit(['-C', files.root, 'init', '-q']);
  runFixtureGit(['-C', files.root, 'config', 'user.email', 'stall@example.test']);
  runFixtureGit(['-C', files.root, 'config', 'user.name', 'Stall Test']);
  files.write('a.txt', 'candidate\n');
  runFixtureGit(['-C', files.root, 'add', '-A']);
  runFixtureGit(['-C', files.root, 'commit', '-q', '-m', 'candidate']);
  return { repo: files.root, commit: runFixtureGit(['-C', files.root, 'rev-parse', 'HEAD']) };
}

/** Open a fresh real board file and hand its SQLite handle to the body. */
async function withBoard(body) {
  const files = privateFixtureFiles('pullboard-stall-board-');
  return withFixtureBoard(join(files.root, 'board.sqlite'), board => body(board.db));
}

/**
 * A stand-in for canonical Submit that calls its stage runner as submitHere does. `stage(attempt, name, signal)` runs
 * one stage of one Submit attempt; `calls` records each attempt with the item it was asked to submit.
 */
function submitWith(stage, calls, commit) {
  return async (ctx, item) => {
    const attempt = calls.push({ item });
    await (ctx.runGateStages ?? runGateStages)(STAGES.map(name => ({ name, run: signal => stage(attempt, name, signal) })));
    ctx.submissionResult.value = { commit };
  };
}

/** A section that never finishes and ignores its signal, as #2828's did after its selection step. */
const never = () => new Promise(() => {});

/**
 * Drive one gate-drive job with the hand-off worker's own drive: drainLoop over driveOnce with drivenHandoffGate, its
 * stall bound shortened, and the worker's refusal shape for a spent stall.
 */
async function driveWorker(db, { repo, commit, submit, healthy, wait }) {
  const handoff = '7a1b2c3d-0000-4000-8000-000000000001';
  const id = gateDriveJobId(handoff);
  createJob(db, { id, kind: GATE_DRIVE_KIND, item: 7, candidate: commit, base: commit });
  const gate = drivenHandoffGate({}, { item: 7 }, { waitInventory: async () => null, submit, healthy, wait });
  const started = Date.now();
  const last = await drainLoop(db, id, { owner: 'driver-stall', repo, gate, intervalMs: 5, stallMs: STALL_MS, stallCheckMs: CHECK_MS, stalled: handoffRefusedResult });
  return { last, job: jobView(db, id), ms: Date.now() - started };
}

/** The steps of one name on a job view, as payloads. */
const steps = (job, name) => job.steps.filter(step => step.name === name).map(step => step.payload);

test('clause 1: a gate drive whose section never finishes is ended by the drive cell and retried once at the same candidate [C7]', { timeout: 30_000 }, async () => {
  assert.equal(GATE_STALL_MS, 20 * 60_000, 'production ends a gate after 20 minutes with no step');
  assert.equal(GATE_STALL_RETRIES, 1, 'production reruns a stalled gate once');
  const { repo, commit } = candidateRepo();

  // The first run's tests section never finishes; the rerun finishes green.
  await withBoard(async db => {
    const calls = [];
    const submit = submitWith((attempt, name) => (attempt === 1 && name === 'tests' ? never() : { name }), calls, commit);
    const { last, job, ms } = await driveWorker(db, { repo, commit, submit });
    assert.equal(last.phase, 'verdict', 'the drive reached its verdict instead of renewing forever');
    assert.deepEqual(steps(job, 'gate.stalled').map(({ attempt, retry, lastStep }) => ({ attempt, retry, lastStep })),
      [{ attempt: 1, retry: true, lastStep: 'section.done' }], 'one stall, ended by the drive cell and retried');
    assert.deepEqual(calls, [{ item: 7 }, { item: 7 }], 'the same item ran twice: the first run and its one retry');
    assert.equal(job.candidate, commit, 'the retry ran the same captured candidate');
    const collected = steps(job, 'collected')[0];
    assert.deepEqual(collected.result, { code: 0, commit }, 'the retry\'s green result is the gate\'s');
    assert.equal(collected.stalls, 1);
    assert.deepEqual(steps(job, 'section.done').filter(row => row.section === 'tests').map(row => row.outcome), ['pass'],
      'the stalled run recorded nothing for its hung tests section; only the retry\'s tests ran to a result');
    assert.equal(steps(job, 'verdict')[0].verdict, 'green');
    assert.ok(ms < 2 * STALL_MS + 3_000, `the stall was ended in ${ms} ms`);
  });

  // Both runs hang: the drive ends the gate as infrastructure after its one retry.
  await withBoard(async db => {
    const calls = [];
    const submit = submitWith((attempt, name) => (name === 'tests' ? never() : { name }), calls, commit);
    const { last, job, ms } = await driveWorker(db, { repo, commit, submit });
    assert.equal(last.phase, 'verdict');
    assert.deepEqual(steps(job, 'gate.stalled').map(row => row.retry), [true, false], 'one retry, then the gate ends');
    assert.equal(calls.length, 2, 'no third run of the candidate');
    const { result } = steps(job, 'collected')[0];
    assert.equal(result.code, 1);
    assert.equal(result.error.code, 'GATE_INFRA_EXHAUSTED', 'a spent stall ends as an infrastructure stop, never a builder red');
    assert.ok(INFRASTRUCTURE_CODES.has(result.error.code), 'the board records the code as infrastructure');
    assert.match(result.error.message, /recorded no step/u);
    assert.equal(typeof result.error.next, 'string');
    assert.ok(ms < 3 * STALL_MS + 3_000, `both stalls ended in ${ms} ms`);
  });
});

test('clause 2: a gate whose tests section was skipped RUNNER_UNAVAILABLE re-dispatches it when a runner returns, or ends infrastructure-red [C7]', { timeout: 30_000 }, async () => {
  const { repo, commit } = candidateRepo();
  /** The first Submit attempt: static loses its runner, and the tests section, stopped by that red, is skipped. */
  const firstAttempt = (name, signal) => {
    if (name === 'static') return Promise.reject(new Refused('RUNNER_UNAVAILABLE', 'runner coreyolson@192.168.1.53 is quarantined'));
    if (name === 'tests') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Refused('RUNNER_UNAVAILABLE', 'no runner for the tests section')), { once: true }));
    return { name };
  };
  const noPause = async () => {};

  // The runner returns after one failed probe: the tests section is dispatched again and the gate goes green.
  await withBoard(async db => {
    const calls = [];
    const probes = [false, true];
    const submit = submitWith((attempt, name, signal) => (attempt === 1 ? firstAttempt(name, signal) : { name }), calls, commit);
    const { job } = await driveWorker(db, { repo, commit, submit, healthy: async () => probes.shift() ?? true, wait: noPause });
    const tests = steps(job, 'section.done').filter(row => row.section === 'tests');
    assert.deepEqual(tests.map(row => [row.outcome, row.code]), [['skip', 'RUNNER_UNAVAILABLE'], ['pass', null]],
      'the skipped tests section ran again once a runner answered');
    assert.equal(calls.length, 2);
    assert.deepEqual(steps(job, 'collected')[0].result, { code: 0, commit });
  });

  // A runner answers but the re-dispatched tests section never finishes: the gate ends infrastructure-red.
  await withBoard(async db => {
    const calls = [];
    const submit = submitWith((attempt, name, signal) => (attempt === 1 ? firstAttempt(name, signal) : name === 'tests' ? never() : { name }), calls, commit);
    const { last, job } = await driveWorker(db, { repo, commit, submit, healthy: async () => true, wait: noPause });
    assert.equal(last.phase, 'verdict', 'the gate never waits forever on the re-dispatched section');
    const { result } = steps(job, 'collected')[0];
    assert.equal(result.error.code, 'GATE_INFRA_EXHAUSTED');
    assert.ok(INFRASTRUCTURE_CODES.has(result.error.code), 'an infrastructure stop: the builder gets no red');
    assert.deepEqual(steps(job, 'gate.stalled').map(row => row.retry), [true, false]);
  });

  // No runner ever returns: the bounded health waits end the gate infrastructure-red.
  await withBoard(async db => {
    const calls = [];
    const submit = submitWith((attempt, name, signal) => firstAttempt(name, signal), calls, commit);
    const { last, job } = await driveWorker(db, { repo, commit, submit, healthy: async () => false, wait: noPause });
    assert.equal(last.phase, 'verdict');
    const { result } = steps(job, 'collected')[0];
    assert.equal(result.error.code, 'GATE_INFRA_EXHAUSTED', 'no runner returned, so the gate ended instead of waiting');
    assert.equal(calls.length, 1, 'with no runner the section was never re-dispatched onto nothing');
    assert.deepEqual(steps(job, 'gate.stalled'), []);
  });
});

test('clause 3: the production sentinel loop shouts Stuck naming the item and job of a gate drive with no step for 20 minutes [C7]', { timeout: 120_000 }, async t => {
  const helpers = createE2eHelpers();
  let box;
  try { box = helpers.project('true', helpers.sandbox()); }
  catch (error) { helpers.cleanup(); throw error; }
  t.after(() => helpers.cleanup());
  const result = fixtureAdd(box.run, box.repo, 'web', 'Hung gate drive', '--route', 'strong', '--specs', 'G1',
    '--criterion', 'A hung gate drive is shouted.', '--check', 'true', '--wait', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  const id = JSON.parse(result.out).item.item_id;
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const hung = gateDriveJobId('7a1b2c3d-0000-4000-8000-0000000000aa');
  const fresh = gateDriveJobId('7a1b2c3d-0000-4000-8000-0000000000bb');
  // @pullboard-board-file journey: write two live gate-drive rows as a renewing driver leaves them.
  withFixtureBoard(boardFile, board => {
    const now = Date.now();
    for (const [job, lastAt] of [[hung, now - 25 * 60_000], [fresh, now - 60_000]]) {
      createJob(board.db, { id: job, kind: GATE_DRIVE_KIND, item: id, now: lastAt });
      writeStep(board.db, job, 'admitted', { owner: 'driver-hung', relaunches: 0 }, { now: lastAt - 1_000 });
      writeStep(board.db, job, 'section.done', { section: 'selection', index: 1, outcome: 'pass', code: null }, { now: lastAt });
      assert.equal(takeJob(board.db, job, 'driver-hung', { now }).taken, true, 'the driver holds a live, renewed lease');
    }
  });

  /** The Stuck shouts the sentinel recorded for a gate drive. */
  const stuckShouts = () => {
    // @pullboard-board-file journey: read the shouts the sentinel recorded.
    return withFixtureBoard(boardFile, after => after.db.prepare("SELECT shout_text, shout_to FROM shout WHERE shout_text LIKE 'Stuck:%GATE_DRIVE_STALLED%'").all());
  };
  // A scan that a concurrent board write made stale records nothing and the next scheduled run records it, so allow three.
  let shouts = [];
  for (let run = 0; run < 3 && !shouts.length; run += 1) {
    const sweep = (await box.runLocal(box.repo, 'sentinel', 'run', '--health-only'));
    assert.equal(sweep.code, 0, `${sweep.err}\n${sweep.out}`);
    shouts = stuckShouts();
  }
  assert.equal(shouts.length, 1, `one Stuck shout, for the hung drive only: ${JSON.stringify(shouts)}`);
  assert.equal(shouts[0].shout_to, 'coordinator');
  assert.match(shouts[0].shout_text, new RegExp(`^Stuck: #${id} gate drive renews its lease with no step \\[GATE_DRIVE_STALLED\\]`, 'u'), 'the shout names the item');
  assert.ok(shouts[0].shout_text.includes(hung), 'the shout names the gate drive job');
  assert.ok(!shouts[0].shout_text.includes(fresh), 'a drive with a recent step is not stuck');
});

/**
 * The drive's clock, moved by hand: `advance` skips simulated minutes, and `tick` resolves at the drive's next
 * lease renewal, the moment its stall watch reads the clock, so a test waits on the watch itself, not on a timer.
 */
function driveClock() {
  let skew = 0;
  let waiters = [];
  return {
    now: () => Date.now() + skew,
    advance: ms => { skew += ms; },
    ticked: () => { const due = waiters; waiters = []; for (const resolve of due) resolve(); },
    tick: () => new Promise(resolve => { waiters.push(resolve); }),
  };
}

/**
 * Drive one gate-drive job with the hand-off worker's own drive on the production stall bound, its clock moved by
 * hand, on job rows a recorder writes to the real board; every ticket row is a stall-watch tick.
 */
async function driveClocked(db, { repo, commit, submit, clock }) {
  const id = gateDriveJobId('7a1b2c3d-0000-4000-8000-000000003829');
  createJob(db, { id, kind: GATE_DRIVE_KIND, item: 7, candidate: commit, base: commit });
  const rows = rowSink(jobView(db, id), row => {
    const answer = recordJobRow(db, row);
    if (row.type === 'ticket') clock.ticked();
    return answer;
  });
  const gate = drivenHandoffGate({}, { item: 7 }, { waitInventory: async () => null, submit });
  const last = await drainLoop(rows, id, { owner: 'driver-progress', repo, gate, intervalMs: 5, stallMs: GATE_STALL_MS, stallCheckMs: CHECK_MS, stalled: handoffRefusedResult, now: clock.now });
  return { last, job: jobView(db, id) };
}

/** The longest gap between two consecutive steps of a job, in milliseconds. */
function longestGap(job) {
  const times = job.steps.map(step => step.at).sort((a, b) => a - b);
  return times.slice(1).reduce((gap, at, index) => Math.max(gap, at - times[index]), 0);
}

test('clause 1: a gate waiting for a runner, then running tests, for 25 minutes writes progress steps and is not stalled [C7]', { timeout: 30_000 }, async () => {
  const { repo, commit } = candidateRepo();
  await withBoard(async db => {
    const clock = driveClock();
    const calls = [];
    const tests = async () => {
      // Ten minutes in line for a runner: each wait poll goes through the gate's own runner-wait callback.
      const onWait = progressingWait(() => {});
      for (let minute = 0; minute < 10; minute += 1) { clock.advance(60_000); onWait({ position: 1 }); await clock.tick(); }
      // Fifteen minutes running tests: the gate's own beat, its timer driven by the test's clock.
      let beat = null;
      await whileGateRuns(async () => {
        for (let minute = 0; minute < 15; minute += 1) { clock.advance(60_000); beat(); await clock.tick(); }
      }, { every: callback => { beat = callback; return 1; }, cancel: () => { beat = null; } });
      return { name: 'tests' };
    };
    const submit = submitWith((attempt, name) => (name === 'tests' ? tests() : { name }), calls, commit);
    const { last, job } = await driveClocked(db, { repo, commit, submit, clock });
    assert.equal(last.phase, 'verdict');
    assert.deepEqual(steps(job, 'gate.stalled'), [], 'the progressing gate was never ended as stalled');
    assert.equal(calls.length, 1, 'the candidate ran once');
    assert.equal(steps(job, 'verdict')[0].verdict, 'green');
    const progress = steps(job, 'gate.progress');
    assert.equal(progress.filter(row => row.waiting).length, 10, 'each minute in line wrote a progress step');
    assert.ok(progress.filter(row => row.running).length >= 14, `the running tests wrote a progress step a minute: ${JSON.stringify(progress)}`);
    const tested = job.steps.filter(step => step.name === 'gate.progress');
    assert.ok(tested.at(-1).at - tested[0].at >= 24 * 60_000, 'the tests section ran for 25 simulated minutes');
    assert.ok(longestGap(job) <= 2 * 60_000, `no two steps were more than 2 minutes apart: ${longestGap(job)} ms`);
  });
});

test('clause 2: a gate whose tests section reports no progress for 20 minutes still stalls [C7]', { timeout: 30_000 }, async () => {
  const { repo, commit } = candidateRepo();
  await withBoard(async db => {
    const clock = driveClock();
    const calls = [];
    const silent = async signal => {
      for (let minute = 0; minute < 25; minute += 1) {
        if (signal?.aborted) return never();
        clock.advance(60_000);
        await clock.tick();
      }
      throw new Error('the silent tests section outlived the 20-minute stall bound');
    };
    const submit = submitWith((attempt, name, signal) => (attempt === 1 && name === 'tests' ? silent(signal) : { name }), calls, commit);
    const { last, job } = await driveClocked(db, { repo, commit, submit, clock });
    assert.equal(last.phase, 'verdict');
    const stalled = steps(job, 'gate.stalled');
    assert.deepEqual(stalled.map(({ attempt, retry, lastStep }) => ({ attempt, retry, lastStep })), [{ attempt: 1, retry: true, lastStep: 'section.done' }],
      'the silent run was ended by the stall watch and retried, as before');
    assert.ok(stalled[0].idleMs >= GATE_STALL_MS, `ended after ${stalled[0].idleMs} ms with no step`);
    assert.deepEqual(steps(job, 'gate.progress'), [], 'a section that reports nothing writes no progress step');
    assert.equal(calls.length, 2);
    assert.equal(steps(job, 'verdict')[0].verdict, 'green');
  });
});
