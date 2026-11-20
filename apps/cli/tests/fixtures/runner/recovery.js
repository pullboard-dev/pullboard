/** @pullboard-test-input source-tree */
/** Actual pinned-worker recovery controls, included by the frozen runner suite [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import {
  existsSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createE2eHelpers } from '../e2e.js';
import { runFixtureChild } from '../child.js';
import { HOST } from './ssh.js';
import { installSshStandIn } from './ssh.js';
import { privateFixtureFiles } from '../child.js';
import { preparedRunner } from '../../../../../packages/runners/tests/fixtures/prepared.js';
import { initializeRunnerRecovery } from '../../../../../packages/resources/index.js';
import { recordRunnerFailure } from '../../../../../packages/resources/index.js';
import {
  claimRunnerLaunch,
  recordRunnerCompletion,
  runnerHealthReply,
} from '../../../../../packages/runners/index.js';
import { recoverUnavailableRunners } from '../../../../../packages/resources/index.js';

/** Open only a private queue; it has no configured machine hosts or leases. */
function queue(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL);CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)');
  initializeRunnerRecovery(db);
  t.after(() => db.close());
  return db;
}

/** A synthetic identity exercises queue concurrency only, never authorizes an actual worker reply. */
function identity(request = randomUUID()) {
  return { version: 1, launchFence: 1, request, nonce: randomUUID(), tooling: 'a'.repeat(64) };
}

/** Register the real pinned-worker probe cases: one failed probe recovers, endless failures stay unavailable [C7]. */
export function runnerProbeRecoveryTests(failureCounts = [1, 99]) {
  for (const failures of failureCounts) {
    test(`a real pinned worker ${failures === 1 ? 'recovers after one failed probe' : 'stays unavailable naming its failed step'} [C7]`, t => {
      const e2e = createE2eHelpers(); t.after(e2e.cleanup);
      const box = e2e.project('true');
      const bin = join(box.dir, 'health-bin');
      const { worker, home, machineHome } = preparedRunner(() => privateFixtureFiles('pullboard-prepared-runner-').root);
      for (const directory of [bin, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(directory, { recursive: true });
      const requests = join(box.dir, 'requests.jsonl');
      installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath, healthFailures: failures });
      const runner = { host: HOST, node: process.execPath, slots: 1, browser: 0 };
      const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
      delete env.NODE_TEST_CONTEXT;
      const runners = pathToFileURL(join(import.meta.dirname, '../../../../../packages/runners/index.js')).href;
      const recovery = pathToFileURL(join(import.meta.dirname, '../../../../../packages/resources/index.js')).href;
      const script = `import {runOnRunnerAsync,probeRunnerHealth} from ${JSON.stringify(runners)};
import {initializeRunnerRecovery,recordRunnerFailure,recoverUnavailableRunners} from ${JSON.stringify(recovery)};
import {DatabaseSync} from 'node:sqlite';import {readdirSync,readFileSync} from 'node:fs';import {join} from 'node:path';
const runner=${JSON.stringify(runner)};
const actual=await runOnRunnerAsync(process.cwd(),'true',{runner,metadata:{item:'fixture',kind:'remote-command'}});
const directory=${JSON.stringify(join(home, '.pullboard-runner', 'recovery'))};
const names=readdirSync(directory);if(names.length!==1)throw new Error('expected one actual completed job');
const proof=JSON.parse(readFileSync(join(directory,names[0]),'utf8'));
const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL);CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)');initializeRunnerRecovery(db);
recordRunnerFailure(db,runner.host,'worker-unresponsive',{reason:'controlled readiness failure',recovery:proof});
const options={probe:probeRunnerHealth,now:Date.now()+2000};
const first=await recoverUnavailableRunners(db,[runner],options);
const held=db.prepare('SELECT * FROM runner_unavailable').get();
const beforeBackoff=await recoverUnavailableRunners(db,[runner],options);
const second=await recoverUnavailableRunners(db,[runner],{probe:probeRunnerHealth,now:held.probe_after});
const wrong=${failures === 1} ? await probeRunnerHealth(runner,[{...proof,nonce:'00000000-0000-0000-0000-000000000000'}]) : null;
console.log(JSON.stringify({wrong,actual:actual.isGreen,first,beforeBackoff,firstFailure:JSON.parse(held.failure).latestProbe,attempts:held.probe_attempts,second,remaining:db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n,events:db.prepare('SELECT kind FROM runner_recovery_event ORDER BY rowid').all()}));db.close();`;
      const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: box.repo, env, encoding: 'utf8', timeout: 90_000 });
      assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
      const actual = JSON.parse(result.stdout);
      assert.equal(actual.actual, true, 'cleanup authority came from a real completed worker job');
      assert.equal(actual.first, false);
      assert.equal(actual.beforeBackoff, false);
      assert.equal(actual.attempts, 1);
      assert.equal(actual.firstFailure.step, 'worker readiness');
      assert.equal(actual.second, failures === 1);
      assert.equal(actual.remaining, failures === 1 ? 0 : 1);
      assert.deepEqual(actual.events.map(event => event.kind), failures === 1
        ? ['unavailable', 'worker-probe-failed', 'available']
        : ['unavailable', 'worker-probe-failed', 'worker-probe-failed']);
      const probes = readFileSync(requests + '.health-probes', 'utf8').trim().split('\n');
      if (failures === 1) { assert.equal(actual.wrong.healthy, false); assert.equal(actual.wrong.step, 'cleanup'); }
      assert.equal(probes.length, failures === 1 ? 3 : 2, 'backoff prevents another SSH call before its due time');
    });
  }
}

/** Register the drained-custody case; the delayed-installer cases drove the SSH controller and are gone with #7526 [C7]. */
export function runnerInstallerRecoveryTests({ custody = true } = {}) {
  if (custody) test('drained custody requires exact job-directory absence and refuses unknown filesystem states [C7]', t => {
    const e2e = createE2eHelpers(); t.after(e2e.cleanup);
    const box = e2e.project('true'), root = join(box.dir, 'owned-runner');
    const previous = identity(), job = previous.request + '-ABC123';
    mkdirSync(join(root, 'jobs', job), { recursive: true });
    assert.equal(claimRunnerLaunch(root, previous), true);
    recordRunnerCompletion(root, previous, job);
    const request = { nonce: randomUUID(), previous };
    assert.equal(runnerHealthReply(root, request).cleanup, false, 'a marker alone cannot bless files that remain');
    renameSync(join(root, 'jobs'), join(root, 'jobs-held'));
    writeFileSync(join(root, 'jobs'), 'not a directory');
    assert.equal(runnerHealthReply(root, request).cleanup, false, 'ENOTDIR is unknown, not ENOENT');
    rmSync(join(root, 'jobs')); renameSync(join(root, 'jobs-held'), join(root, 'jobs'));
    rmSync(join(root, 'jobs', job), { recursive: true });
    assert.equal(runnerHealthReply(root, request).cleanup, true);
    const file = join(root, 'recovery', previous.request + '.json');
    const actual = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...actual, job: '../foreign-job' }));
    assert.equal(runnerHealthReply(root, request).cleanup, false, 'foreign path bindings never establish cleanup');
    const legacy = { ...identity(), launchFence: undefined };
    assert.equal(runnerHealthReply(root, { nonce: randomUUID(), previous: legacy }).cleanup, false);
    assert.equal(existsSync(join(root, 'recovery-launches', legacy.request)), false, 'an old request cannot be guessed never-started');
  });
}

/** Register the alternate-runner admission case and the in-memory hold cases [C7]. */
export function runnerHoldRecoveryTests() {
  test('a free alternate runner admits while another host health probe is pending [C7]', t => {
    const e2e = createE2eHelpers(); t.after(e2e.cleanup);
    const box = e2e.project('true');
    const resources = pathToFileURL(join(import.meta.dirname, '../../../../../packages/resources/index.js')).href;
    const recovery = resources;
    const source = `import {listResources,takeResource,runnerResourceStatus} from ${JSON.stringify(resources)};
import {recordRunnerFailure} from ${JSON.stringify(recovery)};import {DatabaseSync} from 'node:sqlite';
listResources();const db=new DatabaseSync(process.env.PULLBOARD_MACHINE_HOME+'/resources.sqlite');
const runners=[{host:'free-alternate',slots:1,browser:0},{host:'failed-alternate',slots:1,browser:0}];
recordRunnerFailure(db,runners[1].host,'worker-unresponsive',{recovery:${JSON.stringify(identity())}});
db.prepare('UPDATE runner_unavailable SET probe_after=0').run();
let finish,probes=0;const pending=new Promise(resolve=>{finish=resolve;});
const lease=await takeResource({name:'gate',capacity:0,scope:'machine',remote:true,allowIdleCapacityUpdate:true,
runnerProvider:()=>runners,runnerHealthProbe:async()=>{probes++;return pending;}});
const admitted=lease.runner.host,probesAtAdmission=probes;lease.release();finish({healthy:true});
const deadline=Date.now()+2000;while(db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n){if(Date.now()>deadline)throw new Error('background health did not finish');await new Promise(resolve=>setTimeout(resolve,20));}
db.prepare("INSERT INTO runner_unavailable(host,since,detail) VALUES(?,?,?)").run(runners[1].host,new Date(0).toISOString(),'TRANSPORT_LOST');
const aged=runnerResourceStatus(runners).find(row=>row.host===runners[1].host);
const next=await takeResource({name:'gate',capacity:0,scope:'machine',remote:true,allowIdleCapacityUpdate:true,runnerProvider:()=>runners,runnerHealthProbe:async()=>{probes++;return {healthy:true};}});
const admittedAgain=next.runner.host;next.release();
console.log(JSON.stringify({aged,admittedAgain,admitted,probesAtAdmission,probes,events:db.prepare('SELECT kind FROM runner_recovery_event ORDER BY rowid').all()}));db.close();`;
    const env = { ...box.env }; delete env.NODE_TEST_CONTEXT;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.admitted, 'free-alternate');
    assert.equal(actual.probesAtAdmission, 1, 'the due recovery started without blocking admission');
    assert.equal(actual.probes, 1);
    assert.equal(actual.aged.unavailable, true, 'an aged legacy record never makes its host available');
    assert.equal(actual.aged.unavailableReason, 'TRANSPORT_LOST', 'legacy identity is retained for its explicit manual recovery');
    assert.match(actual.aged.recoveryFailure.reason, /manual runner command/u);
    assert.equal(actual.admittedAgain, 'free-alternate', 'admission also excludes the aged legacy host');
    assert.deepEqual(actual.events.map(event => event.kind), ['unavailable', 'available']);
  });
  test('the old Node-only recovery predicate cannot clear new proof-required transport holds [C7]', t => {
    const db = queue(t), runner = { host: 'private-protocol-upgrade', slots: 1, browser: 0 };
    recordRunnerFailure(db, runner.host, 'transport-lost', { recovery: identity() });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM runner_unavailable WHERE detail='TRANSPORT_LOST'").get().n, 0);
    assert.equal(db.prepare("DELETE FROM runner_unavailable WHERE host=? AND detail='TRANSPORT_LOST'").run(runner.host).changes, 0);
    assert.equal(db.prepare('SELECT detail FROM runner_unavailable WHERE host=?').get(runner.host).detail, 'TRANSPORT_UNVERIFIED');
  });
  test('legacy cleanup holds never infer recovery from a healthy callback [C7]', async t => {
    const db = queue(t), runner = { host: 'private-legacy', slots: 1, browser: 0 };
    recordRunnerFailure(db, runner.host, 'cleanup-unverified', { reason: 'old failure without job custody' });
    let probes = 0;
    assert.equal(await recoverUnavailableRunners(db, [runner], { now: Date.now() + 2000, probe: async () => { probes++; return { healthy: true }; } }), false);
    assert.equal(probes, 0);
    assert.match(JSON.parse(db.prepare('SELECT failure FROM runner_unavailable').get().failure).latestProbe.reason, /missing exact request ID or completion record/u);
  });
  test('newer failures retain all pending jobs and invalidate a stale successful probe [C7]', async t => {
    const db = queue(t), runner = { host: 'private-generation', slots: 1, browser: 0 };
    const first = identity(), second = identity();
    recordRunnerFailure(db, runner.host, 'worker-unresponsive', { recovery: first });
    // The pass calls its probe a microtask after it starts (#11011), so the newer failure lands only once the probe is pending.
    let finish, probing;
    const called = new Promise(resolve => { probing = resolve; });
    const pending = recoverUnavailableRunners(db, [runner], { now: Date.now() + 2000, probe: () => new Promise(resolve => { finish = resolve; probing(); }) });
    await called;
    recordRunnerFailure(db, runner.host, 'cleanup-unverified', { recovery: second });
    finish({ healthy: true });
    assert.equal(await pending, false);
    const row = db.prepare('SELECT * FROM runner_unavailable').get();
    assert.equal(row.detail, 'CLEANUP_UNVERIFIED');
    assert.deepEqual(JSON.parse(row.failure).pending, [first, second]);
  });
}
