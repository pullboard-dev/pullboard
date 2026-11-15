/** @pullboard-test-loads packages/runners/src/io/dispatch.js */
/** @pullboard-test-loads packages/runners/src/io/health.js */
/** @pullboard-test-loads packages/runners/index.js */
/** @pullboard-test-loads apps/runner/src/io/scripts/worker.js */
/** @pullboard-test-loads apps/runner/src/io/controller.js */
/** @pullboard-test-loads packages/gate/src/io/main.js */
/** @pullboard-test-loads packages/runners/index.js */
/** @pullboard-test-loads packages/landing/index.js */
/** Exact job observations and owned SSH teardown, registered by the combined orphan-recovery check [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runnerJobReply } from '../../../../../packages/runners/index.js';
import { processCensus } from '../../../../runner/index.js';
import { isolateTestMachine } from '../../../../../packages/gate/index.js';
import { createE2eHelpers } from '../e2e.js';
import { runFixtureChild } from '../child.js';
import { runFixtureChildAsync } from '../child.js';
import { installSshStandIn } from './ssh.js';
import { privateFixtureFiles } from '../child.js';
import { preparedRunner } from '../../../../../packages/runners/tests/fixtures/prepared.js';
import { HOST } from './ssh.js';
import { executionServicesSource } from '../gate/execution.js';
import { waitForCondition } from './holders.js';

/** Source URLs resolve in the actual checked implementation, not a second installed tool. */
const sourceURL = file => pathToFileURL(join(import.meta.dirname, '../../../../..', file)).href;

/** A private native project, SSH namespace and fixture-only model; real machine settings are never altered. */
function project(t) {
  const helpers = createE2eHelpers(), sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'Test Model';
  isolateTestMachine(sandbox.env, sandbox.dir);
  const box = helpers.project('true', sandbox, { withWorktree: false });
  const record = join(box.dir, 'job.json');
  t.after(async () => {
    let owned = [];
    try {
      ({ owned = [] } = JSON.parse(readFileSync(record, 'utf8')));
      for (const owner of owned) {
        if (processCensus()?.get(owner.pid)?.started !== owner.started) continue;
        for (const signal of ['SIGTERM', 'SIGKILL']) { try { process.kill(owner.pid, signal); } catch { /* This exact owned fixture process already exited. */ } }
      }
    } catch { /* Setup may fail before this private fixture creates any process. */ }
    if (owned.length) await waitForCondition(() => {
      const census = processCensus();
      return census && owned.every(owner => { const found = census.get(owner.pid); return !found || found.started !== owner.started || found.state?.startsWith('Z'); });
    }, 'owned runner fixture processes exit', { signal: AbortSignal.timeout(5_000) }); // Budget: bounded drain of the fixture's exact owned processes.
    helpers.cleanup();
  });
  return { ...box, record };
}

/** A controlled transport with a real native startup owner; health requests still execute the pinned worker. */
function transport(t, mode) {
  const box = project(t), bin = join(box.dir, 'ssh-bin'), root = join(box.dir, 'remote-root');
  const { worker, home, machineHome } = preparedRunner(() => privateFixtureFiles('pullboard-prepared-runner-').root);
  for (const path of [bin, root]) mkdirSync(path, { recursive: true });
  const requests = join(box.dir, 'requests.jsonl');
  const probeReplies = join(box.dir, 'job-probe-replies.jsonl');
  const ssh = installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath });
  renameSync(ssh, join(bin, 'ssh-delegate'));
  const ownerSource = `import {claimRunnerLaunch,claimRunnerWorker} from ${JSON.stringify(sourceURL('packages/runners/index.js'))};
import {processCensus} from ${JSON.stringify(sourceURL('apps/runner/index.js'))};
const [root,encoded]=process.argv.slice(1), recovery=JSON.parse(encoded);
if(!claimRunnerLaunch(root,recovery)||!claimRunnerWorker(root,recovery,processCensus))process.exit(2);
process.stdout.write('CLAIMED\\n');setInterval(()=>{},1000);`;
  const wrapper = `#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {processCensus} from ${JSON.stringify(sourceURL('apps/runner/index.js'))};
const args=process.argv.slice(2), command=args.at(-1), mode=${JSON.stringify(mode)}, root=${JSON.stringify(root)};
if(command.includes(' --health ')||command.includes(' --restart ')||command.includes('/* pullboard registration GUI probe */')||command.includes('process.stdout.write(JSON.stringify({nonce:')){
 const child=spawn(process.execPath,[${JSON.stringify(join(bin, 'ssh-delegate'))},...args],{stdio:['inherit','pipe','inherit']});
 process.stdout.on('error',()=>{});child.stdout.on('data',part=>{if(command.includes(' --health '))appendFileSync(${JSON.stringify(probeReplies)},part);process.stdout.write(part);});
 child.once('exit',code=>{process.exitCode=code??255;});
}else{
 process.on('SIGTERM',()=>{});let frame=Buffer.alloc(0),started=false,capsule=false;
 // stdin carries the tooling capsule record first, then the work frame record, each length-prefixed (4e8628b548).
 process.stdin.on('data',async part=>{frame=Buffer.concat([frame,part]);if(started)return;
 for(;;){const newline=frame.indexOf(10);if(newline<0)return;
 const length=Number(frame.subarray(0,newline));if(!Number.isSafeInteger(length)||length<1||length>(capsule?4194304:1048576))process.exit(2);
 if(frame.length<newline+1+length)return;const record=frame.subarray(newline+1,newline+1+length);frame=frame.subarray(newline+1+length);
 if(!capsule){capsule=true;continue;}
 started=true;const spec=JSON.parse(record);
 const owner=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(ownerSource)},root,JSON.stringify(spec.recovery)],{stdio:['ignore','pipe','inherit']});
 await once(owner.stdout,'data');const startup=join(root,'recovery-launches',spec.recovery.request,'startup.json');
 const state=JSON.parse(readFileSync(startup,'utf8'));const own=processCensus().get(process.pid);const owned=[{pid:own.pid,started:own.started},state.owner];
 if(mode==='gone'){const exit=once(owner,'exit');owner.kill('SIGTERM');await exit;}
 if(mode==='unknown')writeFileSync(startup,JSON.stringify({...state,nonce:'00000000-0000-0000-0000-000000000000'}));
 if(mode==='cleanup'){const pipe=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});
  let identity;for(let i=0;i<100&&!identity;i++){identity=processCensus()?.get(pipe.pid);if(!identity)await new Promise(r=>setTimeout(r,5));}
  if(identity)owned.push({pid:identity.pid,started:identity.started});}
 writeFileSync(${JSON.stringify(box.record)},JSON.stringify({job:spec.id,recovery:spec.recovery,owner:state.owner,owned}));
 process.stderr.write('PULLBOARD_RUNNER_READY '+spec.id+'\\n');
 if(mode==='healthy')setInterval(()=>process.stderr.write('PULLBOARD_RUNNER_HEARTBEAT '+spec.id+'\\n'),5000);
 if(mode==='cleanup'){
  const waiter=owned.at(-1), details={id:spec.id,stage:'descendants',processes:[{pid:waiter.pid,command:process.execPath,started:waiter.started,birth:null}]};
  process.stderr.write('PULLBOARD_RUNNER_CLEANUP_DETAILS '+spec.id+' '+Buffer.from(JSON.stringify(details)).toString('base64')+'\\nPULLBOARD_RUNNER_CLEANUP_UNVERIFIED '+spec.id+' controlled unknown cleanup\\nPULLBOARD_RUNNER_CLEANUP_TIMEOUT '+spec.id+'\\n');
 }
 setInterval(()=>{},1000);
 return;}
 });process.stdin.resume();
}
`;
  writeFileSync(ssh, wrapper, { mode: 0o700 });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  return { ...box, requests, probeReplies, runner: { host: HOST, node: process.execPath, root, slots: 1, browser: 0 } };
}

/** Exercise the actual fresh controller; a fixture watchdog reports a failure instead of hanging the combined check. */
async function run(box, abortAfterReady = false) {
  const source = `import {runOnRunnerAsync} from ${JSON.stringify(sourceURL('packages/runners/index.js'))};
import {existsSync} from 'node:fs';
const cancellation=new AbortController();let readyAt=null;
const watch=${abortAfterReady} ? setInterval(()=>{if(readyAt===null&&existsSync(${JSON.stringify(box.record)}))readyAt=Date.now();
if(readyAt!==null&&Date.now()-readyAt>=28000)cancellation.abort();},100):null;
try{await runOnRunnerAsync(process.cwd(),'true',{runner:${JSON.stringify(box.runner)},metadata:{item:'fixture',kind:'remote-command'},signal:cancellation.signal});console.log(JSON.stringify({unexpectedSuccess:true}));}
catch(error){console.log(JSON.stringify({name:error.name,code:error.code,message:error.message,diagnostic:error.diagnostic}));}
finally{clearInterval(watch);}`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

/** Observe real job loss under its own lease, then verify that controlled repeated failures exhaust the bounded retry. */
function retryContract(box) {
  const gate = sourceURL('packages/gate/src/io/main.js'), good = { ...box.runner, host: `${HOST}-setup`, root: join(box.dir, 'good-root') };
  const settings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const stages = join(box.dir, 'retry-stages.jsonl');
  writeFileSync(stages, '');
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(settings, JSON.stringify({ gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true }, runners: [box.runner] }));
  const source = `import {withGateSlot,runProfiledShellAsync} from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
import {RunnerDropped} from ${JSON.stringify(sourceURL('packages/runners/index.js'))};
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
let stageCount=0;
const stage=value=>{if(stageCount++<64||value.stage==='terminal')appendFileSync(${JSON.stringify(stages)},JSON.stringify({at:Date.now(),...value})+'\\n');};
const seen=[],unavailable=[];let attempts=0,loss;
stage({stage:'queue'});
try{await withGateSlot(process.cwd(),async lease=>{seen.push(lease.runner.host);attempts++;
 stage({stage:'action',attempts,host:lease.runner.host});
 if(attempts===1){try{await runProfiledShellAsync(process.cwd(),'true',{gateLease:lease});}
 catch(error){loss={code:error.code,message:error.message,diagnostic:error.diagnostic};stage({stage:'loss',...loss});throw error;}throw new Error('the controlled first job unexpectedly completed');}
 throw new RunnerDropped(lease.runner.host,{reason:'controlled second transport failure'});
},{executionServices,remote:true,runnerOnly:true,kind:'test',onWait(state){
 stage({stage:'wait',admitted:state.admitted??false,unavailable:state.runnerUnavailable??null});
 if(!state.runnerUnavailable)return;unavailable.push(state.runnerUnavailable);
 const config=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
 if(!config.runners.some(row=>row.host===${JSON.stringify(good.host)})){config.runners.push(${JSON.stringify(good)});writeFileSync(${JSON.stringify(settings)},JSON.stringify(config));}
}});console.log(JSON.stringify({unexpectedSuccess:true}));}
catch(error){stage({stage:'terminal',code:error.code,attempts});console.log(JSON.stringify({code:error.code,attempts,seen,unavailable,loss,infrastructureAttempts:error.infrastructureAttempts}));}`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, [result.failure, result.stderr, result.stdout, readFileSync(stages, 'utf8')].filter(Boolean).join('\n'));
  return JSON.parse(result.stdout);
}

/** Register meaningful native-boundary cases without dispatching another test command or claiming board work. */
export function registerRunnerJobLostTests() {
  test('exact job status distinguishes owner identity from unknown observations without certifying cleanup [C7,H16]', t => {
    const box = project(t), root = join(box.dir, 'status'), recovery = { version: 1, request: randomUUID(), nonce: randomUUID(), tooling: 'a'.repeat(64), launchFence: 1 };
    const directory = join(root, 'recovery-launches', recovery.request); mkdirSync(directory, { recursive: true });
    const file = join(directory, 'startup.json'), owner = { pid: 12345, started: 'Thu Oct 29 12:00:00 2026' };
    writeFileSync(file, JSON.stringify({ ...recovery, owner }));
    const request = { nonce: randomUUID(), job: recovery.request, recovery };
    const row = { ...owner, state: 'S' };
    const observe = (value, inspect = () => {}) => runnerJobReply(root, request, { census: () => value, inspect });
    assert.equal(observe(new Map([[owner.pid, row]])).state, 'running');
    assert.equal(observe(new Map([[owner.pid, { ...row, started: 'Fri Oct 30 12:00:00 2026' }]])).state, 'gone');
    assert.equal(observe(new Map([[owner.pid, { ...row, state: 'Z' }]])).state, 'gone');
    assert.equal(observe(new Map(), () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }).state, 'gone');
    assert.equal(observe(new Map(), () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }).state, 'unknown');
    assert.equal(observe(null).state, 'unknown');
    assert.equal(runnerJobReply(root, { ...request, job: randomUUID() }, { census: () => new Map() }).state, 'unknown');
    writeFileSync(file, JSON.stringify({ ...recovery, owner: { ...owner, started: 'malformed' } }));
    assert.equal(observe(new Map()).state, 'unknown');
    writeFileSync(file, JSON.stringify({ ...recovery, nonce: randomUUID(), owner }));
    assert.equal(observe(new Map()).state, 'unknown');
    assert.equal(observe(new Map()).cleanup, false);
  });
  test('a quiet exact job whose native startup owner exited becomes named lost through the real controller bridge [C7,H16]', { skip: 'CONTROLLER_ONLY: deleted with #7526' }, t => {
    const box = transport(t, 'gone'), retry = retryContract(box), result = retry.loss;
    const recorded = JSON.parse(readFileSync(box.record, 'utf8'));
    assert.equal(result.code, 'RUNNER_JOB_LOST');
    assert.equal(result.diagnostic.host, box.runner.host);
    assert.equal(result.diagnostic.job, recorded.job);
    assert.deepEqual(result.diagnostic.recovery, recorded.recovery);
    assert.deepEqual(result.diagnostic.owner, recorded.owner);
    assert.equal(result.diagnostic.remoteCleanup, 'unknown');
    assert.match(result.message, /cleanup remains unknown/u);
    assert.equal(retry.code, 'RUNNER_INFRA_RETRY_EXHAUSTED');
    // The retry window is bounded at ten stops, so a pool that never recovers ends RUNNER_INFRA_RETRY_EXHAUSTED instead of looping.
    assert.equal(retry.attempts, 10, 'ten stops end the retry, never an eleventh action');
    assert.deepEqual(retry.seen, Array.from({ length: 10 }, (_, index) => index % 2 ? `${HOST}-setup` : box.runner.host), 'each retry rotates to the runner not just tried');
    assert.equal(retry.infrastructureAttempts[0].code, 'RUNNER_JOB_LOST');
    assert.match(retry.unavailable[0].until, /exact-job cleanup/u);
    assert.equal(retry.unavailable[0].diagnostic.confirmingProbe, null, 'ordinary healthy SSH cannot erase unknown cleanup');
  });
  test('cleanup timeout settles owned TERM-ignoring SSH and inherited pipes without claiming remote cleanup [C7,H16]', { skip: 'CONTROLLER_ONLY: deleted with #7526' }, async t => {
    const box = transport(t, 'cleanup'), result = await run(box), recorded = JSON.parse(readFileSync(box.record, 'utf8'));
    assert.equal(result.code, 'RUNNER_CLEANUP_TIMEOUT');
    assert.equal(result.diagnostic.request, recorded.job);
    assert.deepEqual(result.diagnostic.recovery, recorded.recovery);
    assert.equal(result.diagnostic.reason, 'cleanup-unverified');
    const waited = result.diagnostic.cleanup.processes;
    assert.equal(waited.length, 1);
    assert.equal(waited[0].pid, recorded.owned.at(-1).pid);
    assert.equal(waited[0].started, recorded.owned.at(-1).started);
    assert.equal(waited[0].command, process.execPath);
    assert.match(result.message, new RegExp(`pid=${waited[0].pid} command=`));
  });
  test('independent job observations never invent remote owner death [C7,H16]', { concurrency: 3, skip: 'CONTROLLER_ONLY: deleted with #7526' }, async t => {
    await Promise.all(['running', 'unknown', 'healthy'].map(mode => t.test(`a ${mode} job observation never invents remote owner death [C7,H16]`, async child => {
    const box = transport(child, mode), result = await run(box, true);
    assert.notEqual(result.code, 'RUNNER_JOB_LOST');
    assert.notEqual(result.unexpectedSuccess, true);
    let probes = '';
    try { probes = readFileSync(box.requests + '.health-probes', 'utf8'); } catch { /* A healthy heartbeat needs no status request. */ }
    if (mode === 'healthy') assert.equal(probes, '', 'five-second exact heartbeats avoid job-status probes');
    else {
      assert.ok(probes.trim(), 'a quiet job received a real pinned-worker status observation');
      const replies = readFileSync(box.probeReplies, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.ok(replies.some(reply => reply.state === (mode === 'running' ? 'running' : 'unknown')));
      assert.ok(replies.every(reply => reply.cleanup === false), 'status observations never certify cleanup');
    }
    })));
  });
}
