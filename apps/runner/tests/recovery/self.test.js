/** Private pinned-worker recovery and sentinel controls for an idle legacy runner [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';
import { runFixtureChild } from '../../../cli/tests/fixtures/child.js';
import { HOST } from '../../../cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../cli/tests/fixtures/runner/ssh.js';

/** Run the pinned health command against one private SSH stand-in and machine home. */
function remoteFixture(t, body) {
  const box = cellProject(t, { gate: 'true' });
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

test('runner.self.an-idle-pinned-runner-with-stale-job: an idle pinned runner with stale job files and missing exact completion recovers once with an audited reason [C7]', t => {
  const runners = pathToFileURL(join(import.meta.dirname, '../../../../packages/runners/index.js')).href;
  const recovery = pathToFileURL(join(import.meta.dirname, '../../../../packages/resources/index.js')).href;
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
    console.log(JSON.stringify({ first, again, latest: db.prepare('SELECT failure FROM runner_unavailable').get(), held: db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n,
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

test('runner.self.a-live-job-stays-unavailable-and-its: a live job stays unavailable and its next idle probe waits thirty seconds [C7]', t => {
  const runners = pathToFileURL(join(import.meta.dirname, '../../../../packages/runners/index.js')).href;
  const recovery = pathToFileURL(join(import.meta.dirname, '../../../../packages/resources/index.js')).href;
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
  assert.equal(actual.delay, 30_000); // budget: declared thirty-second quarantine re-probe cadence (RECOVERY_RETRY_MAX_MS) [C7].
  assert.match(actual.reason, /runner process or job working directory/u);
  assert.deepEqual(actual.events.map(event => event.kind), ['unavailable']);
  assert.equal(readFileSync(requests + '.health-probes', 'utf8').trim().split('\n').length, 1);
});

test('runner.self.a-job-owner-outside-its-job-cwd: a job owner outside its job cwd blocks recovery only until that process exits [C7]', t => {
  const runners = pathToFileURL(join(import.meta.dirname, '../../../../packages/runners/index.js')).href;
  const transport = pathToFileURL(join(import.meta.dirname, '../../../../packages/runners/index.js')).href;
  const { actual } = remoteFixture(t, ({ root }) => `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { existsSync, mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { probeRunnerHealth } from ${JSON.stringify(runners)};
    const runner = { host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, slots: 1, browser: 0 };
    const job = join(${JSON.stringify(root)}, 'jobs', 'owned-job');
    mkdirSync(job);
    const script = 'import {processCensus} from ' + JSON.stringify(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../index.js')).href)}) + ';import {recordRunnerOwner} from ' + JSON.stringify(${JSON.stringify(transport)})
      + ';recordRunnerOwner(' + JSON.stringify(job) + ',processCensus);setInterval(()=>{},60000);';
    const owner = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    let held;
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(join(job, 'worker-owner.json'))) {
        if (Date.now() > deadline || owner.exitCode !== null) throw new Error('worker owner never recorded its identity');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      held = await probeRunnerHealth(runner, undefined, { idle: true });
    } finally { const exited = once(owner, 'exit'); owner.kill('SIGTERM'); await exited; }
    const idle = await probeRunnerHealth(runner, undefined, { idle: true });
    console.log(JSON.stringify({ held, idle }));`);
  assert.equal(actual.held.healthy, false);
  assert.match(actual.held.reason, /runner process or job working directory/u);
  assert.equal(actual.idle.healthy, true, JSON.stringify(actual));
});

test('runner.self.an-unmarked-legacy-worker-through-an-alias: an unmarked legacy worker through an alias blocks only its own runner root [C7]', t => {
  const runners = pathToFileURL(join(import.meta.dirname, '../../../../packages/runners/index.js')).href;
  const { actual } = remoteFixture(t, ({ root }) => `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { probeRunnerHealth } from ${JSON.stringify(runners)};
    const alias = ${JSON.stringify(root)} + '-alias'; symlinkSync(${JSON.stringify(root)}, alias);
    const runtime = join(alias, 'runtime', 'a'.repeat(64), 'src');
    mkdirSync(runtime, { recursive: true });
    const ready = join(runtime, 'ready');
    const entry = join(runtime, 'runner-worker.js');
    writeFileSync(entry, 'require("node:fs").writeFileSync(' + JSON.stringify(ready) + ',"running");setInterval(()=>{},60000)');
    const owner = spawn(process.execPath, [entry], { stdio: 'ignore' });
    const runner = { host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, slots: 1, browser: 0, root: alias };
    let held;
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline || owner.exitCode !== null) throw new Error('legacy worker never became ready');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      held = await probeRunnerHealth(runner, undefined, { idle: true });
    } finally { const exited = once(owner, 'exit'); owner.kill('SIGTERM'); await exited; }
    const idle = await probeRunnerHealth(runner, undefined, { idle: true });
    const malformed = join(${JSON.stringify(root)}, 'jobs', 'malformed-owner'); mkdirSync(malformed);
    writeFileSync(join(malformed, 'worker-owner.json'), JSON.stringify({ pid: 0, started: '' }));
    const unknown = await probeRunnerHealth(runner, undefined, { idle: true });
    console.log(JSON.stringify({ held, idle, unknown }));`);
  assert.equal(actual.held.healthy, false);
  assert.match(actual.held.reason, /runner process or job working directory/u);
  assert.equal(actual.idle.healthy, true, JSON.stringify(actual));
  assert.equal(actual.unknown.healthy, false, 'a malformed owner record cannot establish idle');
});

test('runner.self.a-runner-resource-lease-prevents-an-idle: a runner resource lease prevents an idle proof even without a job cwd [C7]', t => {
  const runners = pathToFileURL(join(import.meta.dirname, '../../../../packages/runners/index.js')).href;
  const { actual } = remoteFixture(t, ({ machineHome }) => `
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    import { probeRunnerHealth } from ${JSON.stringify(runners)};
    const db = new DatabaseSync(join(${JSON.stringify(machineHome)}, 'resources.sqlite'));
    db.exec('CREATE TABLE holder(name TEXT NOT NULL,agent TEXT NOT NULL)');
    db.prepare('INSERT INTO holder VALUES(?,?)').run('gate', 'pullboard-ssh-private-job');
    const runner = { host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, slots: 1, browser: 0 };
    const held = await probeRunnerHealth(runner, undefined, { idle: true });
    db.exec('DELETE FROM holder'); db.close();
    const idle = await probeRunnerHealth(runner, undefined, { idle: true });
    console.log(JSON.stringify({ held, idle }));`);
  assert.equal(actual.held.healthy, false);
  assert.match(actual.held.reason, /resource lease is active/u);
  assert.equal(actual.idle.healthy, true, JSON.stringify(actual));
});

test('runner.self.a-runner-unavailable-thirty-minutes-appears-in: a runner unavailable thirty minutes appears in the sentinel health findings [C7]', t => {
  const recovery = pathToFileURL(join(import.meta.dirname, '../../../../packages/resources/index.js')).href;
  const health = pathToFileURL(join(import.meta.dirname, '../../../../packages/health/index.js')).href;
  const box = cellProject(t, { gate: 'true' });
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
