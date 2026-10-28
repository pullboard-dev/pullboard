/** @pullboard-test-input source-tree */
/** Actual pinned-worker recovery controls, included by the frozen runner suite [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { HOST } from './runner-ssh-fixture.js';
import { installSshStandIn } from './runner-ssh-fixture.js';
import { initializeRunnerRecovery } from '../src/runner-recovery.js';
import { recordRunnerFailure } from '../src/runner-recovery.js';
import { recoverUnavailableRunners } from '../src/runner-recovery.js';

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
  return { version: 1, request, nonce: randomUUID(), tooling: 'a'.repeat(64) };
}

/** Register real worker recovery cases under the existing frozen whole-runner check. */
export function runnerRecoveryTests() {
  for (const failures of [1, 99]) {
    test(`a real pinned worker ${failures === 1 ? 'recovers after one failed probe' : 'stays unavailable naming its failed step'} [C7]`, t => {
      const e2e = createE2eHelpers(); t.after(e2e.cleanup);
      const box = e2e.project('true');
      const bin = join(box.dir, 'health-bin'), worker = join(box.dir, 'worker');
      const home = join(box.dir, 'remote-home'), machineHome = join(home, '.pullboard');
      for (const directory of [bin, worker, home, machineHome]) mkdirSync(directory, { recursive: true });
      const requests = join(box.dir, 'requests.jsonl');
      installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath, healthFailures: failures });
      const runner = { host: HOST, node: process.execPath, slots: 1, browser: 0 };
      const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
      delete env.NODE_TEST_CONTEXT;
      const runners = pathToFileURL(join(import.meta.dirname, '../src/runners.js')).href;
      const recovery = pathToFileURL(join(import.meta.dirname, '../src/runner-recovery.js')).href;
      const script = `import {runOnRunnerAsync,probeRunnerHealth} from ${JSON.stringify(runners)};
import {initializeRunnerRecovery,recordRunnerFailure,recoverUnavailableRunners} from ${JSON.stringify(recovery)};
import {DatabaseSync} from 'node:sqlite';import {readdirSync,readFileSync} from 'node:fs';import {join} from 'node:path';
const runner=${JSON.stringify(runner)};
const actual=await runOnRunnerAsync(process.cwd(),'true',{runner});
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
      assert.deepEqual(actual.events.map(event => event.kind), failures === 1 ? ['unavailable', 'available'] : ['unavailable']);
      const probes = readFileSync(requests + '.health-probes', 'utf8').trim().split('\n');
      if (failures === 1) { assert.equal(actual.wrong.healthy, false); assert.equal(actual.wrong.step, 'cleanup'); }
      assert.equal(probes.length, failures === 1 ? 3 : 2, 'backoff prevents another SSH call before its due time');
    });
  }
  test('a free alternate runner admits while another host health probe is pending [C7]', t => {
    const e2e = createE2eHelpers(); t.after(e2e.cleanup);
    const box = e2e.project('true');
    const resources = pathToFileURL(join(import.meta.dirname, '../src/resources.js')).href;
    const recovery = pathToFileURL(join(import.meta.dirname, '../src/runner-recovery.js')).href;
    const source = `import {listResources,takeResource} from ${JSON.stringify(resources)};
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
console.log(JSON.stringify({admitted,probesAtAdmission,probes,events:db.prepare('SELECT kind FROM runner_recovery_event ORDER BY rowid').all()}));db.close();`;
    const env = { ...box.env }; delete env.NODE_TEST_CONTEXT;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.admitted, 'free-alternate');
    assert.equal(actual.probesAtAdmission, 1, 'the due recovery started without blocking admission');
    assert.equal(actual.probes, 1);
    assert.deepEqual(actual.events.map(event => event.kind), ['unavailable', 'available']);
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
    let finish;
    const pending = recoverUnavailableRunners(db, [runner], { now: Date.now() + 2000, probe: () => new Promise(resolve => { finish = resolve; }) });
    recordRunnerFailure(db, runner.host, 'cleanup-unverified', { recovery: second });
    finish({ healthy: true });
    assert.equal(await pending, false);
    const row = db.prepare('SELECT * FROM runner_unavailable').get();
    assert.equal(row.detail, 'CLEANUP_UNVERIFIED');
    assert.deepEqual(JSON.parse(row.failure).pending, [first, second]);
  });
}
