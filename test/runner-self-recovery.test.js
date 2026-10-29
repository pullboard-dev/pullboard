/** Private pinned-worker recovery and sentinel controls for an idle legacy runner [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { HOST } from './runner-ssh-fixture.js';
import { installSshStandIn } from './runner-ssh-fixture.js';

/** Run the pinned health command against one private SSH stand-in and machine home. */
function remoteFixture(t, body) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const bin = join(box.dir, 'health-bin');
  const worker = join(box.dir, 'worker');
  const home = join(box.dir, 'remote-home');
  const machineHome = join(home, '.pullboard');
  const root = join(home, '.pullboard-runner');
  const requests = join(box.dir, 'requests.jsonl');
  for (const directory of [bin, worker, home, machineHome, root, join(root, 'jobs')])
    mkdirSync(directory, { recursive: true });
  // Completed runners retain these folders; their presence must not prevent recovery.
  mkdirSync(join(root, 'jobs', 'stale-completed-job'));
  writeFileSync(join(root, 'jobs', 'stale-completed-job', 'old-output'), 'completed');
  installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath });
  const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', body({ box, root, machineHome })],
    { cwd: box.repo, env, encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  return { actual: JSON.parse(result.stdout), requests };
}

test('an idle pinned runner with stale job files and missing exact completion recovers once with an audited reason [C7]', t => {
  const runners = pathToFileURL(join(import.meta.dirname, '../src/runners.js')).href;
  const recovery = pathToFileURL(join(import.meta.dirname, '../src/runner-recovery.js')).href;
  const { actual, requests } = remoteFixture(t, () => `
    import { DatabaseSync } from 'node:sqlite';
    import { probeRunnerHealth } from ${JSON.stringify(runners)};
    import { initializeRunnerRecovery } from ${JSON.stringify(recovery)};
    import { recordRunnerFailure } from ${JSON.stringify(recovery)};
    import { recoverUnavailableRunners } from ${JSON.stringify(recovery)};
    const runner = { host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, slots: 1, browser: 0 };
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL);CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)');
    initializeRunnerRecovery(db);
    recordRunnerFailure(db, runner.host, 'cleanup-unverified', { reason: 'missing exact completion' });
    const first = await recoverUnavailableRunners(db, [runner], { now: Date.now() + 2000,
      probe: probeRunnerHealth, idleProbe: r => probeRunnerHealth(r, undefined, { idle: true }) });
    const again = await recoverUnavailableRunners(db, [runner], { now: Date.now() + 2000,
      probe: probeRunnerHealth, idleProbe: r => probeRunnerHealth(r, undefined, { idle: true }) });
    const events = db.prepare('SELECT kind,detail FROM runner_recovery_event ORDER BY rowid').all();
    console.log(JSON.stringify({ first, again, held: db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n,
      events: events.map(event => ({ kind: event.kind, detail: JSON.parse(event.detail) })) }));
    db.close();`);
  assert.equal(actual.first, true, JSON.stringify(actual));
  assert.equal(actual.again, false);
  assert.equal(actual.held, 0);
  assert.deepEqual(actual.events.map(event => event.kind), ['unavailable', 'available']);
  assert.equal(actual.events[1].detail.priorReason, 'CLEANUP_UNVERIFIED');
  assert.equal(actual.events[1].detail.probe.idle, true);
  assert.equal(actual.events[1].detail.probe.writable, true);
  assert.equal(readFileSync(requests + '.health-probes', 'utf8').trim().split('\n').length, 1);
});

test('a live job stays unavailable and its next idle probe waits five minutes [C7]', t => {
  const runners = pathToFileURL(join(import.meta.dirname, '../src/runners.js')).href;
  const recovery = pathToFileURL(join(import.meta.dirname, '../src/runner-recovery.js')).href;
  const { actual, requests } = remoteFixture(t, ({ root }) => `
    import { DatabaseSync } from 'node:sqlite';
    import { spawn } from 'node:child_process';
    import { existsSync, mkdirSync } from 'node:fs';
    import { once } from 'node:events';
    import { join } from 'node:path';
    import { probeRunnerHealth } from ${JSON.stringify(runners)};
    import { initializeRunnerRecovery } from ${JSON.stringify(recovery)};
    import { recordRunnerFailure } from ${JSON.stringify(recovery)};
    import { recoverUnavailableRunners } from ${JSON.stringify(recovery)};
    const runner = { host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, slots: 1, browser: 0 };
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL);CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)');
    initializeRunnerRecovery(db);
    const job = join(${JSON.stringify(root)}, 'jobs', 'live-job');
    mkdirSync(job);
    const ready = join(job, 'ready');
    const owner = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync("ready","running");setInterval(()=>{},60000)'], { cwd: job, stdio: 'ignore' });
    let observed;
    try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline || owner.exitCode !== null) throw new Error('live fixture job never started');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    recordRunnerFailure(db, runner.host, 'worker-unresponsive', { reason: 'lost completion' });
    const now = Date.now() + 2000;
    const options = { probe: probeRunnerHealth, idleProbe: r => probeRunnerHealth(r, undefined, { idle: true }) };
    const first = await recoverUnavailableRunners(db, [runner], { ...options, now });
    const held = db.prepare('SELECT * FROM runner_unavailable').get();
    const early = await recoverUnavailableRunners(db, [runner], { ...options, now: held.probe_after - 1 });
    observed = { first, early, reason: JSON.parse(held.failure).latestProbe.reason,
      delay: held.probe_after - now, held: db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n,
      events: db.prepare('SELECT kind FROM runner_recovery_event').all() };
    } finally { const exited = once(owner, 'exit'); owner.kill('SIGTERM'); await exited; }
    console.log(JSON.stringify(observed));
    db.close();`);
  assert.equal(actual.first, false);
  assert.equal(actual.early, false);
  assert.equal(actual.held, 1);
  assert.equal(actual.delay, 300_000); // budget: declared five-minute recovery probe cadence in #1809 [C7].
  assert.match(actual.reason, /runner process or job working directory/u);
  assert.deepEqual(actual.events.map(event => event.kind), ['unavailable']);
  assert.equal(readFileSync(requests + '.health-probes', 'utf8').trim().split('\n').length, 1);
});

test('a runner unavailable thirty minutes appears in the sentinel health findings [C7]', t => {
  const recovery = pathToFileURL(join(import.meta.dirname, '../src/runner-recovery.js')).href;
  const health = pathToFileURL(join(import.meta.dirname, '../src/health.js')).href;
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const env = { ...box.env };
  delete env.NODE_TEST_CONTEXT;
  mkdirSync(env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    import { initializeRunnerRecovery } from ${JSON.stringify(recovery)};
    import { healthReport } from ${JSON.stringify(health)};
    const now = new Date();
    const db = new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'));
    db.exec('CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL);CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)');
    initializeRunnerRecovery(db);
    db.prepare('INSERT INTO runner_unavailable(host,since,detail,failure) VALUES(?,?,?,?)')
      .run('private-aged-runner', new Date(now.getTime() - 30 * 60_000).toISOString(), 'WORKER_UNRESPONSIVE', '{}');
    db.close();
    const early = healthReport({ db: null, root: ${JSON.stringify(box.repo)}, config: {},
      now: new Date(now.getTime() - 1), dispatchHealth: () => ({ findings: [] }) });
    const report = healthReport({ db: null, root: ${JSON.stringify(box.repo)}, config: {}, now,
      dispatchHealth: () => ({ findings: [] }) });
    console.log(JSON.stringify({ early: early.stuck.filter(entry => entry.cause === 'RUNNER_UNAVAILABLE'),
      due: report.stuck.filter(entry => entry.cause === 'RUNNER_UNAVAILABLE') }));`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { cwd: box.repo, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.early, []);
  const findings = observed.due;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject, 'private-aged-runner');
  assert.equal(findings[0].ageMinutes, 30);
  assert.match(findings[0].title, /private-aged-runner/u);
});
