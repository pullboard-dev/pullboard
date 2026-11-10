/** @pullboard-test-loads packages/resources/index.js */
/** @pullboard-test-input source-tree */
/** Exact started requests without completion need an idle proof, while live or foreign custody stays held [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';
import { runFixtureChild } from '../../../cli/tests/fixtures/child.js';
import { HOST } from '../../../cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../cli/tests/fixtures/runner/ssh.js';

/** Exercise the real pinned worker and recovery store against a private SSH destination, never the machine pool. */
function control(t, body) {
  const box = cellProject(t, { gate: 'true' }), bin = join(box.dir, 'health-bin'), worker = join(box.dir, 'worker');
  const home = join(box.dir, 'remote-home'), machineHome = join(home, '.pullboard'), root = join(home, '.pullboard-runner');
  const requests = join(box.dir, 'requests.jsonl');
  for (const directory of [bin, worker, home, machineHome, root, join(root, 'jobs')]) mkdirSync(directory, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath });
  const url = file => pathToFileURL(join(import.meta.dirname, '../../../..', file)).href;
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    import { randomUUID } from 'node:crypto';
    import { probeRunnerHealth } from ${JSON.stringify(url('packages/runners/index.js'))};
    import { initializeRunnerRecovery, recordRunnerFailure, recoverUnavailableRunners } from ${JSON.stringify(url('packages/resources/index.js'))};
    import { claimRunnerLaunch, runnerLaunchAllowed, claimRunnerWorker } from ${JSON.stringify(url('packages/runners/index.js'))};
    import { processCensus } from ${JSON.stringify(url('apps/runner/index.js'))};
    const custodyURL = ${JSON.stringify(url('apps/runner/index.js'))};
    const transportURL = ${JSON.stringify(url('packages/runners/index.js'))};
    const root = ${JSON.stringify(root)};
    const runner = { host: ${JSON.stringify(HOST)}, node: ${JSON.stringify(process.execPath)}, root, slots: 1, browser: 0 };
    const identity = { version: 1, launchFence: 1, request: 'orphan-' + randomUUID(), nonce: randomUUID(), tooling: 'a'.repeat(64) };
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL); CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)');
    initializeRunnerRecovery(db);
    const options = { probe: probeRunnerHealth, idleProbe: (r, previous) => probeRunnerHealth(r, previous, { idle: true }) };
    ${body}
    db.close();
  `;
  const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source],
    { cwd: box.repo, env, encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  return { actual: JSON.parse(result.stdout), probes: readFileSync(requests + '.health-probes', 'utf8').trim().split('\n').length };
}

test('a valid started request without completion recovers only after fencing and fresh idle proof [C7]', t => {
  const { actual } = control(t, `
    claimRunnerLaunch(root, identity);
    recordRunnerFailure(db, runner.host, 'cleanup-unverified', { reason: 'lost completion', recovery: identity });
    const first = await recoverUnavailableRunners(db, [runner], { ...options, now: Date.now() + 2000 });
    const events = db.prepare('SELECT kind,detail FROM runner_recovery_event ORDER BY rowid').all();
    console.log(JSON.stringify({ first, held: db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n,
      allowed: runnerLaunchAllowed(root, identity), startup: claimRunnerWorker(root, identity, processCensus),
      events: events.map(row => ({ kind: row.kind, detail: JSON.parse(row.detail) })) }));
  `);
  assert.equal(actual.first, true, JSON.stringify(actual));
  assert.equal(actual.held, 0);
  assert.equal(actual.allowed, false, 'a delayed original worker cannot start after idle recovery');
  assert.equal(actual.startup, false, 'the actual worker startup claim loses to the cancellation fence');
  assert.deepEqual(actual.events.map(row => row.kind), ['unavailable', 'available']);
  assert.equal(actual.events[1].detail.probe.idle, true);
  assert.equal(actual.events[1].detail.probe.writable, true);
});

test('a matching started request with a live job stays unavailable and its health reason names the pid [C7]', t => {
  const { actual } = control(t, `
    const { spawn } = await import('node:child_process');
    const { existsSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { once } = await import('node:events');
    const job = join(root, 'jobs', 'live-job'); mkdirSync(job);
    const ready = join(job, 'ready');
    const owner = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync("ready","running");setInterval(()=>{},60000)'], { cwd: job, stdio: 'ignore' });
    let observed;
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline || owner.exitCode !== null) throw new Error('private job did not become ready');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      claimRunnerLaunch(root, identity);
      recordRunnerFailure(db, runner.host, 'cleanup-unverified', { reason: 'lost completion', recovery: identity });
      const first = await recoverUnavailableRunners(db, [runner], { ...options, now: Date.now() + 2000 });
      const held = db.prepare('SELECT failure FROM runner_unavailable').get();
      observed = { first, pid: owner.pid, held: Boolean(held), reason: JSON.parse(held.failure).latestProbe.reason };
    } finally { const exited = once(owner, 'exit'); owner.kill('SIGTERM'); await exited; }
    console.log(JSON.stringify(observed));
  `);
  assert.equal(actual.first, false);
  assert.equal(actual.held, true);
  assert.match(actual.reason, new RegExp(`\\b${actual.pid}\\b`, 'u'));
});

test('a foreign launch identity never gains idle recovery authority from a quiet host [C7]', t => {
  const { actual, probes } = control(t, `
    claimRunnerLaunch(root, { ...identity, nonce: randomUUID() });
    recordRunnerFailure(db, runner.host, 'cleanup-unverified', { reason: 'foreign launch claim', recovery: identity });
    const first = await recoverUnavailableRunners(db, [runner], { ...options, now: Date.now() + 2000 });
    console.log(JSON.stringify({ first, held: db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n }));
  `);
  assert.equal(actual.first, false);
  assert.equal(actual.held, 1);
  assert.equal(probes, 1, 'foreign custody cannot request an idle fallback');
});

test('the existing legacy idle path remains a discriminating control for missing completion recovery [C7]', t => {
  const { actual, probes } = control(t, `
    recordRunnerFailure(db, runner.host, 'cleanup-unverified', { reason: 'legacy missing identity' });
    const first = await recoverUnavailableRunners(db, [runner], { ...options, now: Date.now() + 2000 });
    console.log(JSON.stringify({ first, held: db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n }));
  `);
  assert.equal(actual.first, true, JSON.stringify(actual));
  assert.equal(actual.held, 0);
  assert.equal(probes, 1);
});

test('a worker paused after startup admission prevents idle recovery before any job or lease exists [C7]', t => {
  const { actual } = control(t, `
    const { spawn } = await import('node:child_process');
    const { existsSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { once } = await import('node:events');
    const ready = join(root, 'startup-ready'), resume = join(root, 'resume-startup'), spawned = join(root, 'job-spawned');
    claimRunnerLaunch(root, identity);
    const source = [
      'import { claimRunnerWorker } from ' + JSON.stringify(transportURL) + ';',
      'import { processCensus } from ' + JSON.stringify(custodyURL) + ';',
      'import { existsSync, writeFileSync } from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      'if (!claimRunnerWorker(' + JSON.stringify(root) + ',' + JSON.stringify(identity) + ',processCensus)) throw new Error("startup fenced");',
      'writeFileSync(' + JSON.stringify(ready) + ', "ready");',
      'while (!existsSync(' + JSON.stringify(resume) + ')) await new Promise(resolve => setTimeout(resolve, 20));',
      'const result = spawnSync(process.execPath, ["-e", ' + JSON.stringify('require("node:fs").writeFileSync(' + JSON.stringify(spawned) + ', "spawned")') + ']);',
      'if (result.status !== 0) throw new Error("private job failed");',
    ].join('\\n');
    const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: process.cwd(), stdio: 'ignore' });
    let observed;
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline || owner.exitCode !== null) throw new Error('paused startup never became ready');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      recordRunnerFailure(db, runner.host, 'cleanup-unverified', { reason: 'missing completion during startup', recovery: identity });
      const first = await recoverUnavailableRunners(db, [runner], { ...options, now: Date.now() + 2000 });
      const held = db.prepare('SELECT * FROM runner_unavailable').get();
      const exited = once(owner, 'exit'); writeFileSync(resume, 'go'); await exited;
      const after = await recoverUnavailableRunners(db, [runner], { ...options, now: held.probe_after + 1 });
      observed = { first, held: Boolean(held), pid: owner.pid, reason: JSON.parse(held.failure).latestProbe.reason,
        spawned: existsSync(spawned), after, remaining: db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n };
    } finally { if (owner.exitCode === null) { const exited = once(owner, 'exit'); owner.kill('SIGTERM'); await exited; } }
    console.log(JSON.stringify(observed));
  `);
  assert.equal(actual.first, false, 'admitted startup cannot be mistaken for idle capacity');
  assert.equal(actual.held, true);
  assert.match(actual.reason, new RegExp(`\\b${actual.pid}\\b`, 'u'));
  assert.equal(actual.spawned, true, 'the admitted worker really spawns after the recovery observation');
  assert.equal(actual.after, true, 'only a later idle observation after that owner exits clears the hold');
  assert.equal(actual.remaining, 0);
});
