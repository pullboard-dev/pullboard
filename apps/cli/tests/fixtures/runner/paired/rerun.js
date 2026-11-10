/** @pullboard-test-input source-tree */
/** Exercise the real registered-runner flake ledger with an isolated committed source [C7]. */
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  availableParallelism,
  loadavg,
  tmpdir,
} from 'node:os';
import { pathToFileURL } from 'node:url';
import { takeResource } from '../../../../../../packages/resources/index.js';
import { runFixtureChildAsync } from '../../child.js';

/** Run one real paired-rerun case; the caller supplies the pinned tooling and round-trip harness. */
export async function runPairedRerun(t, mode, { createE2eHelpers, cli, observe, startToolingCli,
  awaitRoundTrip, phaseCounts, ROUND_TRIP_DEADLINES, HOST, shellQuote, installSshStandIn, processesUnder }, { hold = '', cpuLoad = null } = {}) {
  const helper = createE2eHelpers();
  t.after(helper.cleanup);
  const box = helper.project('true');
  const repo = box.repo;
  const [fixtureBin, remoteHome, worker] = ['runner-bin', 'runner-home', 'second-machine'].map(name => join(box.dir, name));
  const remoteMachineHome = join(remoteHome, '.pullboard');
  for (const folder of [fixtureBin, remoteMachineHome, worker, join(repo, 'test')]) mkdirSync(folder, { recursive: true });
  const env = { ...box.env, PATH: fixtureBin + ':' + box.env.PATH };
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  // Red on its first run, green on its paired rerun: a flake the ledger should record.
  const runs = join(box.dir, 'flaky-runs');
  writeFileSync(join(repo, 'test/flaky.test.js'), `import { test } from 'node:test'; import { appendFileSync, existsSync, readFileSync } from 'node:fs';
test('remote flaky case [C7]', () => { const n = existsSync(${JSON.stringify(runs)}) ? readFileSync(${JSON.stringify(runs)}, 'utf8').length : 0; appendFileSync(${JSON.stringify(runs)}, 'x'); if (n === 0) throw new Error('first run fails'); });\n`);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ ...config, gate: 'node --test --test-reporter=tap test/flaky.test.js', flakes: { rerun: true } }) + '\n');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'test: a remote flaky fixture');
  const preload = join(box.dir, 'worker-preload.mjs');
  const firstReceipt = join(box.dir, 'first-receipt-seen');
  const strip = mode === 'no-load' ? 'true' : `existsSync(${JSON.stringify(firstReceipt)}) || (writeFileSync(${JSON.stringify(firstReceipt)}, ''), false)`;
  writeFileSync(preload, mode === 'remote-load'
    ? "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const os = require('node:os'); os.loadavg = () => [7.25, 7.25, 7.25]; require('node:module').syncBuiltinESMExports();\n"
    : "import { existsSync, writeFileSync } from 'node:fs'; const write = process.stderr.write.bind(process.stderr); process.stderr.write = (chunk, ...rest) => { const text = String(chunk); const match = /^(PULLBOARD_RUNNER_RESULT \\S+ )(\\S+)\\n$/u.exec(text); if (!match) return write(chunk, ...rest); const body = JSON.parse(Buffer.from(match[2], 'base64').toString('utf8')); if (" + strip + ") delete body.load; return write(match[1] + Buffer.from(JSON.stringify(body)).toString('base64') + '\\n', ...rest); };\n");
  installSshStandIn({ bin: fixtureBin, worker, home: remoteHome, machineHome: remoteMachineHome,
    requests: join(box.dir, 'requests.jsonl'), nodeOptions: '--import=' + pathToFileURL(preload).href, hold });
  assert.equal(cli(repo, env, 'settings', 'gateSlots', '1', '--json').status, 0);
  const registered = cli(repo, env, 'runner', 'add', HOST, '--slots', '1', '--browser', '1', '--json');
  assert.equal(registered.status, 0, registered.context);
  const prior = { home: process.env.PULLBOARD_HOME, machine: process.env.PULLBOARD_MACHINE_HOME };
  Object.assign(process.env, { PULLBOARD_HOME: env.PULLBOARD_HOME, PULLBOARD_MACHINE_HOME: env.PULLBOARD_MACHINE_HOME });
  const held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo,
    agent: 'flake-local-holder', item: 'flake-local-holder', kind: 'force-registered-runner' });
  try {
    const requests = join(box.dir, 'requests.jsonl');
    const evidence = join(repo, '.git', 'pullboard', 'flake-evidence');
    // Native diagnostics writes this only after the controller has validated and consumed the
    // first result, before preparing the required pair. A held SSH result never creates it.
    const firstReceiptAccepted = mode === 'no-load' ? null : () => existsSync(evidence)
      && readdirSync(evidence).some(id => existsSync(join(evidence, id, 'original.log')));
    const before = { dispatched: 0, returned: 0 };
    const cpuStartedAt = Date.now();
    const run = observe(startToolingCli(repo, env, ['gate', '--json'], { detached: true }));
    if (hold) {
      const startedAt = Date.now();
      let failure;
      try { await awaitRoundTrip(run.child, run.closed, requests + '.phases', before, ROUND_TRIP_DEADLINES, firstReceiptAccepted); }
      catch (error) { failure = error; }
      assert.ok(failure, 'a runner that withholds the result stays a named deadline failure');
      assert.match(failure.message, /runner round trip stuck in phase "result return"/u,
        'the held receipt fails specifically in the result-return phase');
      const phaseTiming = /no progress after (\d+) ms \(deadline (\d+) ms\)/u.exec(failure.message);
      assert.ok(phaseTiming, failure.message);
      const phaseElapsedMs = Number(phaseTiming[1]);
      const phaseDeadlineMs = Number(phaseTiming[2]);
      assert.equal(phaseDeadlineMs, ROUND_TRIP_DEADLINES['result return'], 'the frozen default result-return deadline is used');
      assert.ok(phaseElapsedMs <= phaseDeadlineMs + 1_000,
        `the held result-return phase is observed at ${phaseElapsedMs} ms, within its ${phaseDeadlineMs} ms deadline plus polling allowance`);
      const elapsedMs = Date.now() - startedAt;
      const roundTripBudgetMs = Object.values(ROUND_TRIP_DEADLINES).reduce((sum, ms) => sum + ms, 0);
      const ceiling = roundTripBudgetMs + 12_000; // existing held-phase setup/drain allowance across all phases.
      assert.ok(elapsedMs < ceiling, `the complete held round trip is stopped in ${elapsedMs} ms, under ${ceiling} ms`);
      t.diagnostic(`held result-return phase: ${failure.message}`);
      assert.deepEqual(phaseCounts(requests + '.phases'), { dispatched: 1, returned: 1 },
        'the worker completed and returned before the stand-in held the result receipt');
      assert.deepEqual(processesUnder(box.dir), [], 'nothing from the held result-return phase keeps running');
      return { held: true };
    }
    const finished = await awaitRoundTrip(run.child, run.closed, requests + '.phases', before, ROUND_TRIP_DEADLINES, firstReceiptAccepted);
    if (cpuLoad) await cpuLoad.assertProgress(cpuStartedAt, Date.now());
    assert.equal(finished.status, 1, 'the original red stays the gate result');
    const [observation] = readdirSync(evidence).map(id => JSON.parse(readFileSync(join(evidence, id, 'observation.json'), 'utf8')));
    t.diagnostic('paired runner observation: ' + JSON.stringify({ classification: observation.classification, reason: observation.reason, paired: observation.paired }));
    const pairedCalls = mode === 'no-load' ? 1 : 2;
    assert.deepEqual(phaseCounts(requests + '.phases'), { dispatched: pairedCalls, returned: pairedCalls },
      'the red check and required paired rerun each complete their runner round trip');
    assert.equal(observation.main, box.git(repo, 'rev-parse', 'HEAD'), 'the pinned main is recorded');
    if (mode === 'remote-load') {
      assert.equal(observation.classification, 'flake', observation.reason);
      assert.deepEqual(observation.load.average, [7.25, 7.25, 7.25], 'the execution host\'s load is recorded, not the controller\'s');
      assert.equal(observation.paired?.green, true, 'the one paired rerun ran and passed');
    } else if (mode === 'no-load') {
      assert.equal(observation.classification, 'unclassified');
      assert.match(observation.reason, /does not carry the execution host's load/u);
      assert.equal(observation.paired, null, 'no rerun is guessed without the host load');
    } else {
      assert.equal(observation.paired?.green, true, 'the paired rerun ran and passed, but its receipt lacks the host load');
      assert.equal(observation.classification, 'unclassified', 'a green pair without its host load never makes a flake: ' + observation.reason);
      assert.match(observation.reason, /paired remote receipt does not carry the execution host's load/u);
    }
    return observation;
  } finally {
    held.release();
    for (const [key, value] of [['PULLBOARD_HOME', prior.home], ['PULLBOARD_MACHINE_HOME', prior.machine]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

/** Prove a second real child attempt receives its own clock even when both markers arrive in one poll. */
export async function assertAttemptDeadlineReset({ phaseCounts, awaitRoundTrip, stopGroup, processesUnder }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-phase-reset-')));
  const phases = join(root, 'phases');
  const before = phaseCounts(phases);
  const script = `const { appendFileSync } = require('node:fs');
const phases = ${JSON.stringify(phases)};
appendFileSync(phases, 'dispatched\\n');
setTimeout(() => {
  appendFileSync(phases, 'returned\\ndispatched\\n');
  setTimeout(() => appendFileSync(phases, 'returned\\n'), 900);
}, 900);`;
  const run = runFixtureChildAsync(process.execPath, ['-e', script], { cwd: root, detached: true });
  try {
    const result = await awaitRoundTrip(run.child, run, phases, before,
      { dispatch: 5_000, 'remote run': 1_500, 'result return': 5_000 });
    assert.equal(result.status, 0, result.context);
    assert.deepEqual(phaseCounts(phases), { dispatched: 2, returned: 2 });
    assert.deepEqual(processesUnder(root), [], 'the two-attempt control is fully drained');
  } finally {
    if (run.child.pid && run.child.exitCode === null && run.child.signalCode === null) await stopGroup(run.child, run);
    rmSync(root, { recursive: true, force: true });
  }
}

/** A consumed first receipt starts the next dispatch clock, while an undelivered receipt never does. */
export async function assertRedispatchDeadlineAccounting({ phaseCounts, awaitRoundTrip, stopGroup }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-redispatch-')));
  const phases = join(root, 'phases');
  const accepted = join(root, 'accepted-receipt');
  const before = phaseCounts(phases);
  const script = `const { appendFileSync, writeFileSync } = require('node:fs');
const phases = ${JSON.stringify(phases)};
appendFileSync(phases, 'dispatched\\n');
setTimeout(() => {
  appendFileSync(phases, 'returned\\n');
  writeFileSync(${JSON.stringify(accepted)}, 'controller accepted first receipt');
  setTimeout(() => {
    appendFileSync(phases, 'dispatched\\n');
    setTimeout(() => appendFileSync(phases, 'returned\\n'), 100);
  }, 900);
}, 100);`;
  const run = runFixtureChildAsync(process.execPath, ['-e', script], { cwd: root, detached: true });
  try {
    const result = await awaitRoundTrip(run.child, run, phases, before,
      { dispatch: 1_500, 'remote run': 1_500, 'result return': 400 },
      () => existsSync(accepted));
    assert.equal(result.status, 0, result.context);
    assert.deepEqual(phaseCounts(phases), { dispatched: 2, returned: 2 });
  } finally {
    if (run.child.pid && run.child.exitCode === null && run.child.signalCode === null) await stopGroup(run.child, run);
    rmSync(root, { recursive: true, force: true });
  }
}
const READY_TIMEOUT_MS = 10_000;
const PROGRESS_TIMEOUT_MS = 15_000;
const TERM_DRAIN_MS = 1_000;
const HARD_LIFETIME_MS = 720_000; // budget: hard orphan ceiling beyond the named 660-second test; parent death also exits within one CPU chunk.

/** Make one worker emit readiness and five monotonic process.cpuUsage deltas while yielding regularly. */
function workerSource(ownerPid, lifetimeMs) {
  return `
const ownerPid = ${ownerPid};
const deadline = Date.now() + ${lifetimeMs};
let stopped = false;
let nextSample = Date.now() + 200;
let round = 0;
let priorCpu = process.cpuUsage();
let priorAt = Date.now();
let progress = 0;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
function emit(value, done = false) {
  process.stdout.write(JSON.stringify(value) + '\\n', done ? () => process.exit(0) : undefined);
}
emit({ type: 'ready', pid: process.pid, ppid: process.ppid, at: Date.now() });
function chunk() {
  if (stopped || Date.now() >= deadline || process.ppid !== ownerPid) {
    emit({ type: 'stopped', pid: process.pid, reason: stopped ? 'signal' : (process.ppid !== ownerPid ? 'parent-death' : 'lifetime') }, true);
    return;
  }
  const until = Date.now() + 50;
  let value = progress + 1;
  while (Date.now() < until) value = Math.sqrt(value + 1.23456789);
  progress += 1;
  if (Date.now() >= nextSample) {
    const cpu = process.cpuUsage(priorCpu);
    const at = Date.now(), since = priorAt;
    priorAt = at;
    priorCpu = process.cpuUsage();
    round += 1;
    nextSample = Date.now() + 200;
    emit({ type: 'progress', pid: process.pid, round, since, at, cpu });
  }
  setImmediate(chunk);
}
setImmediate(chunk);
`;
}

/** Start half-core detached workers and require stdout-backed readiness and five CPU-progress samples. */
export async function startRunnerCpuStandIn() {
  const cores = availableParallelism();
  const count = Math.max(1, Math.floor(cores / 2));
  const loadBefore = loadavg()[0];
  const ownerPid = process.pid;
  const workers = Array.from({ length: count }, () => {
    const run = runFixtureChildAsync(process.execPath, ['-e', workerSource(ownerPid, HARD_LIFETIME_MS)], {
      detached: true,
      windowsHide: true,
    });
    const state = { run, child: run.child, lines: '', records: [], closed: false };
    state.child.stdout.setEncoding('utf8').on('data', chunk => {
      state.lines += chunk;
      for (;;) {
        const newline = state.lines.indexOf('\n');
        if (newline < 0) break;
        const line = state.lines.slice(0, newline);
        state.lines = state.lines.slice(newline + 1);
        try { state.records.push(JSON.parse(line)); }
        catch (error) { state.records.push({ type: 'invalid-json', line, message: error.message }); }
      }
    });
    run.then(() => { state.closed = true; });
    return state;
  });
  let stopping;

  /** Signal a worker's owned detached process group, tolerating an already-drained group. */
  function signalGroup(state, signal) {
    if (state.child.pid === undefined || state.closed) return;
    try { process.kill(-state.child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  /** Stop once, escalate after a bounded drain, and await every captured child close. */
  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      for (const state of workers) signalGroup(state, 'SIGTERM');
      await Promise.race([Promise.all(workers.map(state => state.run)), new Promise(resolve => setTimeout(resolve, TERM_DRAIN_MS))]);
      for (const state of workers) if (!state.closed) signalGroup(state, 'SIGKILL');
      await Promise.all(workers.map(state => state.run));
    })();
    return stopping;
  }

  /** Wait a bounded time for a record predicate and fail early if that worker exits. */
  async function waitForRecord(state, predicate, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = state.records.find(predicate);
      if (record) return record;
      if (state.closed) throw new Error(`CPU worker ${state.child.pid} exited before ${description}`);
      if (Date.now() >= deadline) throw new Error(`CPU worker ${state.child.pid} timed out waiting for ${description}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  try {
    await Promise.all(workers.map(state => waitForRecord(state, record => record.type === 'ready', READY_TIMEOUT_MS, 'stdout readiness')));
    const cpuSnapshots = [];
    for (let round = 1; round <= 5; round++) {
      const records = await Promise.all(workers.map(state => waitForRecord(state,
        record => record.type === 'progress' && record.round === round, PROGRESS_TIMEOUT_MS, `CPU progress round ${round}`)));
      for (const record of records) {
        assert.ok(record.cpu.user + record.cpu.system > 0, `worker ${record.pid} reported no CPU time in round ${round}`);
      }
      cpuSnapshots.push({ round, workers: records.map(({ pid, cpu }) => ({ pid, userMicros: cpu.user, systemMicros: cpu.system })) });
    }
    const report = {
      pids: workers.map(state => state.child.pid),
      count,
      availableParallelism: cores, cores,
      loadBefore,
      loadAfterProgress: loadavg()[0],
      cpuSnapshots,
    };
    return {
      ...report,
      report,
      assertAlive() {
        for (const state of workers) {
          assert.equal(state.closed, false, `owned CPU child ${state.child.pid} remains alive during the capture`);
          assert.ok(state.records.some(record => record.type === 'ready'), `worker ${state.child.pid} emitted stdout readiness`);
        }
      },
      /** Require fresh positive CPU samples during each actual paired round trip. */
      async assertProgress(startedAt, endedAt) {
        const records = await Promise.all(workers.map((state, index) => waitForRecord(state,
          record => record.type === 'progress' && record.since >= startedAt && record.at <= endedAt, 5_000, 'CPU progress inside the actual controller interval')));
        records.forEach((record, index) => {
          assert.ok(record.cpu.user + record.cpu.system > 0, `worker ${record.pid} consumed CPU during the paired run`);
        });
        report.cpuSnapshots.push({ pairedRun: report.cpuSnapshots.length - 4, startedAt, endedAt, workers: records });
      },
      loadAfter: () => loadavg()[0],
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
