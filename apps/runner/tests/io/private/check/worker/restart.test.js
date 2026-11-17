/** @pullboard-test-loads packages/resources/index.js */
/** An idle runner whose pinned worker stops answering restarts that worker itself; a busy one is left alone [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cellProject } from '../../../../../../../packages/store/tests/fixtures/cell.js';
import { runFixtureChild } from '../../../../../../cli/tests/fixtures/child.js';
import { HOST } from '../../../../../../cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../../../cli/tests/fixtures/runner/ssh.js';

/** Hold a hung pinned worker, fail the first health probe, then run recovery with the real restart probe on a private host. */
function observe(t, busy, reason = 'worker-unresponsive') {
  const box = cellProject(t, { gate: 'true' });
  const bin = join(box.dir, 'probe-bin'), home = join(box.dir, 'remote-home');
  const root = join(home, '.pullboard-runner'), machineHome = join(home, '.pullboard');
  const worker = join(box.dir, 'worker'), requests = join(box.dir, 'requests.jsonl');
  const hung = join(root, 'runtime', 'b'.repeat(64), 'apps/runner/src/io/scripts');
  for (const directory of [bin, worker, hung, join(root, 'jobs'), machineHome]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(hung, 'worker.js'), 'setInterval(() => {}, 60000);\n');
  installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath, healthFailures: 1 });
  const url = name => pathToFileURL(join(import.meta.dirname, '../../../../../../..', name)).href;
  const script = `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { randomUUID } from 'node:crypto';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { writeFileSync, mkdirSync } from 'node:fs';
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { probeRunnerHealth } from ${JSON.stringify(url('packages/runners/index.js'))};
    import { processCensus } from ${JSON.stringify(url('apps/runner/index.js'))};
    import { initializeRunnerRecovery, recordRunnerFailure, recoverUnavailableRunners } from ${JSON.stringify(url('packages/resources/index.js'))};
    const root = ${JSON.stringify(root)};
    const runner = { host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, root, slots: 1, browser: 0 };
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL);CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)');
    initializeRunnerRecovery(db);
    const identity = { version: 1, request: randomUUID(), nonce: randomUUID(), tooling: 'a'.repeat(64), launchFence: 1 };
    const stale = spawn(process.execPath, [join(root, 'runtime', 'b'.repeat(64), 'apps/runner/src/io/scripts/worker.js')], { stdio: 'ignore' });
    const exited = once(stale, 'exit');
    let ownerWitness;
    try {
      if (${busy}) {
        const owner = processCensus()?.get(stale.pid);
        assert.ok(owner, 'the real hung worker must appear in the native UTC census');
        assert.equal(owner.pid, stale.pid);
        assert.ok(typeof owner.started === 'string' && owner.started.trim(), 'native owner start must be nonempty');
        mkdirSync(join(root, 'jobs', 'live-job'));
        const ownerFile = join(root, 'jobs', 'live-job', 'worker-owner.json');
        writeFileSync(ownerFile, JSON.stringify({ pid: owner.pid, started: owner.started }));
        const observed = processCensus()?.get(stale.pid);
        assert.ok(observed, 'the recorded owner must still be a live native census row');
        ownerWitness = { recorded: JSON.parse(readFileSync(ownerFile, 'utf8')), observed: { pid: observed.pid, started: observed.started } };
        assert.deepEqual(ownerWitness.recorded, ownerWitness.observed, 'the job owner must name this current worker before recovery');
      }
      recordRunnerFailure(db, runner.host, ${JSON.stringify(reason)}, { recovery: identity });
      const recovered = await recoverUnavailableRunners(db, [runner], { now: Date.now() + 2000, probe: probeRunnerHealth,
        idleProbe: (r, previous) => probeRunnerHealth(r, previous, { idle: true }),
        restartProbe: r => probeRunnerHealth(r, undefined, { restart: true }) });
      await new Promise(resolve => setTimeout(resolve, 1200));
      const held = db.prepare('SELECT * FROM runner_unavailable').get();
      const events = db.prepare('SELECT kind,detail FROM runner_recovery_event ORDER BY rowid').all();
      console.log(JSON.stringify({ recovered, pid: stale.pid, ownerWitness, alive: stale.exitCode === null && stale.signalCode === null,
        held: held && { ...held, failure: JSON.parse(held.failure) },
        events: events.map(event => ({ kind: event.kind, detail: JSON.parse(event.detail) })) }));
    } finally {
      if (stale.exitCode === null && stale.signalCode === null) stale.kill('SIGKILL');
      await exited; db.close();
    }`;
  const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { cwd: box.repo, env, encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('runner.restart.an-idle-unresponsive-worker-is-restarted-by: an idle unresponsive worker is restarted by the next recovery and the runner returns to service, recording the restart [C7]', t => {
  const actual = observe(t, false);
  assert.equal(actual.recovered, true, JSON.stringify(actual));
  assert.equal(actual.held, undefined);
  assert.equal(actual.alive, false, 'the hung worker process was ended');
  assert.deepEqual(actual.events.map(event => event.kind), ['unavailable', 'worker-probe-failed', 'worker-restarted', 'available']);
  assert.deepEqual(actual.events[2].detail.restarted, [actual.pid]);
  assert.equal(actual.events[2].detail.workerState.idle, true);
  assert.equal(actual.events[3].detail.priorReason, 'WORKER_UNRESPONSIVE');
  assert.deepEqual(actual.events[3].detail.probe.restarted, [actual.pid]);
});

test('runner.restart.a-worker-that-owns-a-running-job: a worker that owns a running job is never restarted and the hold names its pid [C7]', t => {
  const actual = observe(t, true);
  assert.deepEqual(actual.ownerWitness.recorded, actual.ownerWitness.observed);
  assert.equal(actual.ownerWitness.observed.pid, actual.pid);
  assert.ok(actual.ownerWitness.observed.started);
  assert.equal(actual.recovered, false, JSON.stringify(actual));
  assert.equal(actual.alive, true, 'the busy worker was left running');
  assert.equal(actual.held.detail, 'WORKER_UNRESPONSIVE');
  assert.match(actual.held.failure.latestProbe.reason, new RegExp('pid ' + actual.pid + '(?:\\D|$)', 'u'));
  assert.deepEqual(actual.events.map(event => event.kind), ['unavailable', 'worker-probe-failed']);
});

test('runner.restart.a-transport-lost-runner-whose-pinned-worker: a transport-lost runner whose pinned worker resets the probe restarts it when idle and returns to service [C7]', t => {
  const actual = observe(t, false, 'transport-lost');
  assert.equal(actual.recovered, true, JSON.stringify(actual));
  assert.equal(actual.held, undefined);
  assert.equal(actual.alive, false, 'the hung worker process was ended');
  assert.deepEqual(actual.events.map(event => event.kind), ['unavailable', 'worker-probe-failed', 'worker-restarted', 'available']);
  assert.deepEqual(actual.events[2].detail.restarted, [actual.pid]);
  assert.equal(actual.events[3].detail.priorReason, 'TRANSPORT_UNVERIFIED');
});

test('runner.restart.a-transport-lost-runner-whose-worker-owns: a transport-lost runner whose worker owns a running job is left unavailable and its worker is not signalled [C7]', t => {
  const actual = observe(t, true, 'transport-lost');
  assert.equal(actual.recovered, false, JSON.stringify(actual));
  assert.equal(actual.alive, true, 'the busy worker was left running');
  assert.equal(actual.held.detail, 'TRANSPORT_UNVERIFIED');
  assert.deepEqual(actual.events.map(event => event.kind), ['unavailable', 'worker-probe-failed']);
});
