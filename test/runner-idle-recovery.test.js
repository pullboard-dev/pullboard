/** @pullboard-test-input source-tree */
/** Exact started requests without completion need an idle proof, while live or foreign custody stays held [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { HOST } from './runner-ssh-fixture.js';
import { installSshStandIn } from './runner-ssh-fixture.js';

/** Exercise the real pinned worker and recovery store against a private SSH destination, never the machine pool. */
function control(t, body) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true'), bin = join(box.dir, 'health-bin'), worker = join(box.dir, 'worker');
  const home = join(box.dir, 'remote-home'), machineHome = join(home, '.pullboard'), root = join(home, '.pullboard-runner');
  const requests = join(box.dir, 'requests.jsonl');
  for (const directory of [bin, worker, home, machineHome, root, join(root, 'jobs')]) mkdirSync(directory, { recursive: true });
  installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath });
  const url = file => pathToFileURL(join(import.meta.dirname, '../src', file)).href;
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    import { randomUUID } from 'node:crypto';
    import { probeRunnerHealth } from ${JSON.stringify(url('runners.js'))};
    import { initializeRunnerRecovery, recordRunnerFailure, recoverUnavailableRunners } from ${JSON.stringify(url('runner-recovery.js'))};
    import { claimRunnerLaunch, runnerLaunchAllowed } from ${JSON.stringify(url('runner-transport.js'))};
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
      allowed: runnerLaunchAllowed(root, identity), events: events.map(row => ({ kind: row.kind, detail: JSON.parse(row.detail) })) }));
  `);
  assert.equal(actual.first, true, JSON.stringify(actual));
  assert.equal(actual.held, 0);
  assert.equal(actual.allowed, false, 'a delayed original worker cannot start after idle recovery');
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
