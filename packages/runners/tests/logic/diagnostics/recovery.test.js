/** @pullboard-test-loads packages/resources/index.js */
/** @pullboard-test-input source-tree */
/** Cleanup holds need a fresh pinned idle worker, not a successful SSH connection alone [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { runFixtureChild } from '../../../../../apps/cli/tests/fixtures/child.js';
import { HOST } from '../../../../../apps/cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../../apps/cli/tests/fixtures/runner/ssh.js';

/** Refuse one exact-health transport, then run the actual pinned worker on a private SSH host. */
function observe(t, mode) {
  const cleanups = [];
  const box = cellProject({ after: cleanup => cleanups.push(cleanup) }, { gate: 'true', model: 'runner-cleanup-recovery-fixture' });
  const bin = join(box.dir, 'cleanup-bin'), home = join(box.dir, 'remote-home');
  const root = join(home, '.pullboard-runner'), machineHome = join(home, '.pullboard');
  const worker = join(box.dir, 'worker'), requests = join(box.dir, 'requests.jsonl');
  for (const directory of [bin, worker, root, join(root, 'jobs'), machineHome]) mkdirSync(directory, { recursive: true });
  t.after(() => { try { chmodSync(root, 0o700); } finally { for (const cleanup of cleanups.reverse()) cleanup(); } });
  const node = join(bin, 'fixture-node');
  // The real installer repairs root permissions. Deny writes only after it finishes, before the real health worker.
  writeFileSync(node, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
const args=process.argv.slice(2), root=${JSON.stringify(root)};
const deny=${JSON.stringify(mode === 'unwritable')} && args.includes('--health');
if(deny)chmodSync(root,0o500);
const child=spawn(process.execPath,args,{stdio:'inherit'});
const restore=()=>{if(deny)chmodSync(root,0o700);};
child.once('error',error=>{restore();console.error(error);process.exitCode=1;});
child.once('close',(code,signal)=>{restore();process.exitCode=signal?1:code;});
process.once('SIGTERM',()=>child.kill('SIGTERM'));
`, { mode: 0o700 });
  installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: node, healthFailures: 1 });
  const ssh = join(bin, 'ssh'), failure = 'record({ healthProbeFailed: true, stdinBytes }); process.exit(255);';
  writeFileSync(ssh, readFileSync(ssh, 'utf8').replaceAll(failure,
    `process.stderr.write(${JSON.stringify('fixture exact-cleanup worker probe refused\n')}); ${failure}`));
  const url = path => pathToFileURL(join(import.meta.dirname, '../../../../..', path)).href;
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { randomUUID } from 'node:crypto';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { existsSync, mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { probeRunnerHealth } from ${JSON.stringify(url('packages/runners/index.js'))};
    import { initializeRunnerRecovery, recordRunnerFailure, recoverUnavailableRunners } from ${JSON.stringify(url('packages/resources/index.js'))};
    import { claimRunnerLaunch, runnerLaunchAllowed } from ${JSON.stringify(url('packages/runners/index.js'))};
    const root=${JSON.stringify(root)};
    const runner={host:${JSON.stringify(HOST)},node:${JSON.stringify(node)},root,slots:1,browser:0};
    const db=new DatabaseSync(':memory:');
    db.exec('CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL);CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)');
    initializeRunnerRecovery(db);
    const identity={version:1,request:randomUUID(),nonce:randomUUID(),tooling:'a'.repeat(64),launchFence:1};
    if(!claimRunnerLaunch(root,identity))throw new Error('private launch claim refused');
    let owner;
    if(${JSON.stringify(mode === 'live')}){
      const job=join(root,'jobs','live-job');mkdirSync(job);
      const ready=join(job,'ready');
      owner=spawn(process.execPath,['-e','require("node:fs").writeFileSync("ready","running");setInterval(()=>{},60000)'],{cwd:job,stdio:'ignore'});
      const deadline=Date.now()+5000;
      while(!existsSync(ready)){
        if(Date.now()>deadline||owner.exitCode!==null)throw new Error('private live job never became ready');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
    }
    try{
      recordRunnerFailure(db,runner.host,'cleanup-unverified',{reason:'exact completion missing after worker refusal',recovery:identity});
      const options={probe:probeRunnerHealth,idleProbe:(r,previous)=>probeRunnerHealth(r,previous,{idle:true})};
      const recovered=await recoverUnavailableRunners(db,[runner],{...options,now:Date.now()+2000});
      const held=db.prepare('SELECT * FROM runner_unavailable').get();
      const events=db.prepare('SELECT kind,detail FROM runner_recovery_event ORDER BY rowid').all();
      console.log(JSON.stringify({recovered,owner:owner?.pid,allowed:runnerLaunchAllowed(root,identity),
        held:held&&{...held,failure:JSON.parse(held.failure)},
        events:events.map(event=>({kind:event.kind,detail:JSON.parse(event.detail)}))}));
    }finally{
      if(owner){const closed=once(owner,'exit');owner.kill('SIGTERM');await closed;}
      db.close();
    }
  `;
  const env = { ...box.env, PATH: `${bin}:${box.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
    { cwd: box.repo, env, encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  const probes = readFileSync(requests + '.health-probes', 'utf8').trim().split('\n').map(JSON.parse);
  return { actual: JSON.parse(result.stdout), probes };
}

test('a cleanup-unverified runner with a failed exact probe recovers only through a fresh pinned idle and writable proof [C7]', t => {
  const { actual, probes } = observe(t, 'clean');
  assert.equal(actual.recovered, true, JSON.stringify(actual));
  assert.equal(actual.held, undefined);
  assert.equal(actual.allowed, false, 'idle proof fences delayed startup for this exact request');
  assert.deepEqual(actual.events.map(event => event.kind), ['unavailable', 'worker-probe-failed', 'available']);
  const failed = actual.events[1].detail;
  assert.equal(failed.failedProbe.diagnostic.workerReady, false);
  assert.equal(failed.failedProbe.diagnostic.exitCode, 255);
  assert.equal(failed.failedProbe.diagnostic.stderr, 'fixture exact-cleanup worker probe refused\n');
  assert.equal(failed.workerState.healthy, true);
  assert.equal(failed.workerState.idle, true);
  assert.equal(failed.workerState.writable, true);
  assert.equal(failed.workerState.code, 0);
  assert.equal(actual.events[2].detail.priorReason, 'CLEANUP_UNVERIFIED');
  assert.equal(actual.events[2].detail.probe.step, 'idle proof');
  assert.match(actual.events[2].detail.probe.reason, /no live runner process, job working directory or resource lease/u);
  assert.equal(probes.length, 2);
  assert.equal(probes[0].healthProbeFailed, true);
  assert.equal(probes[1].code, 0, 'the second request executes the actual pinned health worker');
});

test('a cleanup-unverified runner with a surviving job stays unavailable and names that actual pid [C7]', t => {
  const { actual, probes } = observe(t, 'live');
  assert.equal(actual.recovered, false);
  assert.equal(actual.held.detail, 'CLEANUP_UNVERIFIED');
  assert.match(actual.held.failure.latestProbe.reason, new RegExp('pid ' + actual.owner + '(?:\\D|$)', 'u'));
  assert.equal(actual.held.failure.latestProbe.idle, false);
  assert.deepEqual(actual.events.map(event => event.kind), ['unavailable', 'worker-probe-failed']);
  assert.equal(actual.events[1].detail.workerState.healthy, false);
  assert.equal(probes.length, 2);
});

test('a cleanup-unverified runner whose pinned worker cannot write its root stays unavailable [C7]', t => {
  const { actual, probes } = observe(t, 'unwritable');
  assert.equal(actual.recovered, false);
  assert.equal(actual.held.detail, 'CLEANUP_UNVERIFIED');
  assert.equal(actual.held.failure.latestProbe.step, 'idle proof');
  assert.equal(actual.held.failure.latestProbe.healthy, false);
  assert.equal(actual.held.failure.latestProbe.writable, false);
  assert.equal(actual.held.failure.latestProbe.code, 0, 'a nonce-valid worker answers with an actual OS write refusal');
  assert.match(actual.held.failure.latestProbe.reason, /writable/u);
  assert.deepEqual(actual.events.map(event => event.kind), ['unavailable', 'worker-probe-failed']);
  assert.equal(probes.length, 2);
  assert.equal(probes[1].code, 0);
});
