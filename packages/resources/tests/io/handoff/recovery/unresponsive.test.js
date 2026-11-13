/** @pullboard-test-loads packages/resources/index.js */
/** Recover an unresponsive pinned worker only with exact launch fencing and a fresh idle proof [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { runFixtureChild } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { HOST } from '../../../../../../apps/cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../../../apps/cli/tests/fixtures/runner/ssh.js';

/** Fail the first actual worker probe, then execute the real pinned idle worker on a private host. */
function observe(t, live) {
  const box = cellProject(t, { gate: 'true' });
  const bin = join(box.dir, 'probe-bin'), home = join(box.dir, 'remote-home');
  const root = join(home, '.pullboard-runner'), machineHome = join(home, '.pullboard');
  const worker = join(box.dir, 'worker');
  const requests = join(box.dir, 'requests.jsonl'), stderrLog = join(box.dir, 'worker-stderr');
  for (const directory of [bin, worker, root, join(root, 'jobs'), machineHome]) mkdirSync(directory, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome, requests,
    nodeCommand: process.execPath, healthFailures: 1, stderrLog });
  const ssh = join(bin, 'ssh'), failure = 'record({ healthProbeFailed: true, stdinBytes }); process.exit(255);';
  writeFileSync(ssh, readFileSync(ssh, 'utf8').replaceAll(failure,
    `process.stderr.write(${JSON.stringify('fixture worker start refused\n')}); ${failure}`));
  const url = name => pathToFileURL(join(import.meta.dirname, '../../../../..', name)).href;
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { randomUUID } from 'node:crypto';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { existsSync, mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { probeRunnerHealth } from ${JSON.stringify(url('runners/index.js'))};
    import { initializeRunnerRecovery, recordRunnerFailure, recoverUnavailableRunners } from ${JSON.stringify(url('resources/src/io/recovery.js'))};
    const runner = { host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, root: ${JSON.stringify(root)}, slots: 1, browser: 0 };
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL);CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)');
    initializeRunnerRecovery(db);
    const identity = { version: 1, request: randomUUID(), nonce: randomUUID(), tooling: 'a'.repeat(64), launchFence: 1 };
    let owner;
    if (${live}) {
      const job = join(${JSON.stringify(root)}, 'jobs', 'live-job'); mkdirSync(job);
      const ready = join(job, 'ready');
      owner = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync("ready","running");setInterval(()=>{},60000)'], { cwd: job, stdio: 'ignore' });
      const deadline = Date.now() + 5000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline || owner.exitCode !== null) throw new Error('fixture owner did not start');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try {
      recordRunnerFailure(db, runner.host, 'worker-unresponsive', { recovery: identity });
      const recovered = await recoverUnavailableRunners(db, [runner], { now: Date.now() + 2000,
        probe: probeRunnerHealth, idleProbe: (r, previous) => probeRunnerHealth(r, previous, { idle: true }) });
      const held = db.prepare('SELECT * FROM runner_unavailable').get();
      const events = db.prepare('SELECT kind,detail FROM runner_recovery_event ORDER BY rowid').all();
      console.log(JSON.stringify({ recovered, owner: owner?.pid, held: held && { ...held, failure: JSON.parse(held.failure) },
        events: events.map(event => ({ kind: event.kind, detail: JSON.parse(event.detail) })) }));
    } finally {
      if (owner) { const exited = once(owner, 'exit'); owner.kill('SIGTERM'); await exited; }
      db.close();
    }`;
  const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { cwd: box.repo, env, encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const probes = readFileSync(requests + '.health-probes', 'utf8').trim().split('\n').map(JSON.parse);
  let workerError = '';
  try { workerError = readFileSync(stderrLog, 'utf8'); } catch { /* A refused transport never starts the worker. */ }
  return { actual: { ...JSON.parse(result.stdout), probes, workerError }, probes, healthLine: result.stderr };
}

test('an unresponsive exact worker restarts through the pinned idle proof on the next probe [C7]', t => {
  const { actual, probes, healthLine } = observe(t, false);
  assert.equal(actual.recovered, true, JSON.stringify(actual));
  assert.equal(actual.held, undefined);
  assert.deepEqual(actual.events.map(event => event.kind), ['unavailable', 'worker-probe-failed', 'available']);
  assert.equal(actual.events[1].detail.failedProbe.diagnostic.host, HOST);
  assert.equal(actual.events[1].detail.failedProbe.diagnostic.exitCode, 255);
  assert.equal(actual.events[1].detail.failedProbe.diagnostic.workerReady, false);
  assert.equal(actual.events[1].detail.failedProbe.diagnostic.stderr, 'fixture worker start refused\n');
  assert.equal(actual.events[1].detail.workerState.idle, true);
  assert.equal(actual.events[2].detail.priorReason, 'WORKER_UNRESPONSIVE');
  assert.equal(actual.events[2].detail.probe.idle, true);
  assert.equal(actual.events[2].detail.probe.writable, true);
  assert.equal(probes.length, 2);
  assert.equal(probes[0].healthProbeFailed, true);
  assert.equal(probes[1].code, 0);
  assert.match(healthLine, /runner fixture-host recovered: pinned worker ready; no live runner process/u);
});

test('an unresponsive worker with a live job stays held and names its actual pid [C7]', t => {
  const { actual, probes } = observe(t, true);
  assert.equal(actual.recovered, false);
  assert.equal(actual.held.detail, 'WORKER_UNRESPONSIVE');
  assert.match(actual.held.failure.latestProbe.reason, new RegExp('pid ' + actual.owner + '(?:\\D|$)', 'u'));
  assert.deepEqual(actual.events.map(event => event.kind), ['unavailable', 'worker-probe-failed']);
  assert.equal(actual.events[1].detail.failedProbe.diagnostic.host, HOST);
  assert.equal(actual.events[1].detail.failedProbe.diagnostic.exitCode, 255);
  assert.equal(actual.events[1].detail.workerState.idle, false);
  assert.match(actual.events[1].detail.workerState.reason, new RegExp('pid ' + actual.owner + '(?:\\D|$)', 'u'));
  assert.equal(probes.length, 2);
});
