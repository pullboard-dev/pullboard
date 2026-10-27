/** @pullboard-test-input source-tree */
/** Actual SSH protocol failures retain evidence and recover through the shared queue [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { HOST } from './runner-ssh-fixture.js';
import { installSshStandIn } from './runner-ssh-fixture.js';
import { initializeRunnerRecovery } from '../src/runner-recovery.js';
import { recordRunnerFailure } from '../src/runner-recovery.js';
import { recoverUnavailableRunners } from '../src/runner-recovery.js';

// Budget: the real configured-Node observation must recover in seconds, well before the old five-minute retry.
const RECOVERY_BOUND_MS = 5_000;

/** Build a real private project and a private SSH executable; no configured machine host is contacted. */
function fixture(t) {
  const e2e = createE2eHelpers(); t.after(e2e.cleanup);
  const box = e2e.project('true');
  const bin = join(box.dir, 'transport-bin'), worker = join(box.dir, 'worker');
  const home = join(box.dir, 'worker-home'), machineHome = join(home, '.pullboard');
  for (const folder of [bin, worker, home, machineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  const requests = join(box.dir, 'requests.jsonl');
  installSshStandIn({ bin, worker, home, machineHome, requests, dropFirst: true, nodeCommand: process.execPath });
  const ssh = join(bin, 'ssh');
  writeFileSync(ssh, readFileSync(ssh, 'utf8').replace('record({ dropped: true, stdinBytes,',
    "process.stderr.write('controlled transport disconnection\\n'); record({ dropped: true, stdinBytes,"));
  box.env.PATH = `${bin}:${box.env.PATH}`;
  const runner = { host: `${HOST}-drop`, slots: 1, browser: 0, node: process.execPath };
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({
    gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true }, runners: [runner],
  }));
  return { ...box, requests, runner };
}

/** Execute the current implementation inside the fixture's own environment and retain an actionable assertion. */
function child(box, source) {
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 90_000,
  });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

/** A real SQLite queue containing only this test's health generations. */
function queue(t) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL); CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)");
  initializeRunnerRecovery(db); t.after(() => db.close());
  return db;
}

test('a failed SSH call preserves its command exit and stderr through the synchronous bridge [C7]', t => {
  const box = fixture(t);
  const url = pathToFileURL(join(import.meta.dirname, '../src/runners.js')).href;
  const result = child(box, `import {runOnRunner} from ${JSON.stringify(url)};
    try {runOnRunner(process.cwd(),'true',{runner:${JSON.stringify(box.runner)}});process.exitCode=1;}
    catch(error){console.log(JSON.stringify({name:error.name,diagnostic:error.diagnostic}));}`);
  assert.equal(result.name, 'RunnerDropped');
  assert.equal(result.diagnostic.exitCode, 255);
  assert.equal(result.diagnostic.command[0], 'ssh');
  assert.ok(result.diagnostic.command.includes(box.runner.host));
  assert.equal(result.diagnostic.reason, 'receipt-count');
  assert.match(result.diagnostic.stderr, /controlled transport disconnection/u);
  assert.match(result.diagnostic.source, /^[0-9a-f]{40}$/u);
});

test('one transient SSH failure is confirmed before a healthy runner is readmitted without quarantine [C7]', t => {
  const box = fixture(t);
  const url = pathToFileURL(join(import.meta.dirname, '../src/gate.js')).href;
  const result = child(box, `import {withGateSlot,runProfiledShellAsync} from ${JSON.stringify(url)};
    import {DatabaseSync} from 'node:sqlite';
    const run=await withGateSlot(process.cwd(),lease=>runProfiledShellAsync(process.cwd(),
      'node -e "console.log(\'RECOVERED_EXECUTION\')"',{gateLease:lease}),{remote:true,onWait(){}});
    const db=new DatabaseSync(process.env.PULLBOARD_MACHINE_HOME+'/resources.sqlite',{readOnly:true});
    const unavailable=db.prepare('SELECT * FROM runner_unavailable').all();
    const failures=db.prepare('SELECT * FROM runner_transport_error').all();db.close();
    console.log(JSON.stringify({green:run.isGreen,output:run.output,unavailable,failures}));`);
  assert.equal(result.green, true);
  assert.equal(result.output.match(/RECOVERED_EXECUTION/gu)?.length, 1);
  assert.deepEqual(result.unavailable, []);
  assert.equal(result.failures.length, 1);
  const diagnostic = JSON.parse(result.failures[0].diagnostic);
  assert.equal(diagnostic.exitCode, 255);
  assert.equal(diagnostic.confirmingProbe.healthy, true);
  const requests = readFileSync(box.requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(requests.length, 3, 'failed dispatch, one confirming Node observation, one actual recovered execution');
  assert.equal(requests[0].dropped, true);
});

test('a recovered runner is cleared on its first successful probe instead of a five minute expiry [C7]', async t => {
  const db = queue(t), runner = { host: 'private-recovery-host', slots: 1, browser: 0 };
  const original = { command: ['ssh', runner.host, '[worker]'], exitCode: 255, stderr: 'controlled connection failure' };
  recordRunnerFailure(db, runner.host, 'transport-lost', original);
  db.prepare('UPDATE runner_unavailable SET probe_after=0').run();
  assert.equal(await recoverUnavailableRunners(db, [runner], { probe: async () => ({ healthy: false, reason: 'still down' }) }), false);
  const failed = db.prepare('SELECT * FROM runner_unavailable').get();
  assert.deepEqual(JSON.parse(failed.failure).original, original);
  assert.equal(JSON.parse(failed.failure).latestProbe.reason, 'still down');
  db.prepare('UPDATE runner_unavailable SET probe_after=0').run();
  assert.equal(await recoverUnavailableRunners(db, [runner], { probe: async () => ({ healthy: true }) }), true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n, 0);
});

test('real configured Node recovery clears the transport row within seconds [C7]', t => {
  const box = fixture(t);
  const runner = { ...box.runner, host: HOST };
  const recovery = pathToFileURL(join(import.meta.dirname, '../src/runner-recovery.js')).href;
  const transport = pathToFileURL(join(import.meta.dirname, '../src/runner-transport.js')).href;
  const result = child(box, `import {DatabaseSync} from 'node:sqlite';
    import {initializeRunnerRecovery,recordRunnerFailure,recoverUnavailableRunners} from ${JSON.stringify(recovery)};
    import {probeRunnerTransport} from ${JSON.stringify(transport)};
    const runner=${JSON.stringify(runner)},db=new DatabaseSync(':memory:');
    db.exec("CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL);CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)");
    initializeRunnerRecovery(db);
    const bad=await probeRunnerTransport({...runner,node:${JSON.stringify(join(box.dir, 'missing-configured-node'))}});
    recordRunnerFailure(db,runner.host,'transport-lost',{command:bad.command,exitCode:bad.code,reason:bad.reason});
    db.prepare('UPDATE runner_unavailable SET probe_after=0').run();
    const started=Date.now(),recovered=await recoverUnavailableRunners(db,[runner]);
    console.log(JSON.stringify({bad,recovered,elapsed:Date.now()-started,remaining:db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n}));db.close();`);
  assert.equal(result.bad.healthy, false);
  assert.equal(result.bad.code, 127);
  assert.equal(result.recovered, true);
  assert.equal(result.remaining, 0);
  assert.ok(result.elapsed < RECOVERY_BOUND_MS, `observed recovery took ${result.elapsed}ms`);
});

test('concurrent recovery probes cannot clear a newer transport failure or cleanup hold [C7]', async t => {
  const db = queue(t), runner = { host: 'private-generation-host', slots: 1, browser: 0 };
  recordRunnerFailure(db, runner.host, 'transport-lost', { reason: 'first' });
  db.prepare('UPDATE runner_unavailable SET probe_after=0').run();
  let finish, called = 0;
  const pending = recoverUnavailableRunners(db, [runner], { probe: () => { called++; return new Promise(resolve => { finish = resolve; }); } });
  assert.equal(await recoverUnavailableRunners(db, [runner], { probe: async () => { called++; return { healthy: true }; } }), false);
  assert.equal(called, 1, 'the shared row admits one observing client');
  recordRunnerFailure(db, runner.host, 'cleanup-unverified', { reason: 'new cleanup uncertainty' });
  finish({ healthy: true });
  assert.equal(await pending, false);
  assert.equal(db.prepare('SELECT detail FROM runner_unavailable').get().detail, 'CLEANUP_UNVERIFIED');
});

test('an automatic transport probe never clears a draining runner or guesses health [C7]', async t => {
  const db = queue(t), runner = { host: 'private-draining-host', slots: 1, browser: 0 };
  recordRunnerFailure(db, runner.host, 'transport-lost', { reason: 'missing receipt' });
  db.prepare('UPDATE runner_unavailable SET probe_after=0').run();
  db.prepare('INSERT INTO runner_draining(host,runner) VALUES(?,?)').run(runner.host, JSON.stringify(runner));
  let probes = 0;
  assert.equal(await recoverUnavailableRunners(db, [runner], { probe: async () => { probes++; return { healthy: true }; } }), false);
  assert.equal(probes, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n, 1);
});
