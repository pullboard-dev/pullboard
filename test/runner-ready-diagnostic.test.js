/** @pullboard-test-input source-tree */
/** Actual SSH protocol failures retain evidence and recover through the shared queue [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createE2eHelpers } from './e2e-helpers.js';
import { copyPackageFiles } from '../src/package-files.js';
import { runFixtureChild } from './fixture-child.js';
import { HOST } from './runner-ssh-fixture.js';
import { installSshStandIn } from './runner-ssh-fixture.js';
import { initializeRunnerRecovery } from '../src/runner-recovery.js';
import { recordRunnerFailure } from '../src/runner-recovery.js';
import { recoverUnavailableRunners } from '../src/runner-recovery.js';

// Budget: the real configured-Node observation must recover in seconds, well before the old five-minute retry.
const RECOVERY_BOUND_MS = 5_000;

/** Build a real private project and a private SSH executable; no configured machine host is contacted. */
function fixture(t, { dropFirst = true } = {}) {
  const e2e = createE2eHelpers(); t.after(e2e.cleanup);
  const box = e2e.project('true');
  const bin = join(box.dir, 'transport-bin'), worker = join(box.dir, 'worker');
  const home = join(box.dir, 'worker-home'), machineHome = join(home, '.pullboard');
  for (const folder of [bin, worker, home, machineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  const requests = join(box.dir, 'requests.jsonl'), starts = join(box.dir, 'starts.jsonl');
  installSshStandIn({ bin, worker, home, machineHome, requests, starts, dropFirst, nodeCommand: process.execPath });
  const ssh = join(bin, 'ssh');
  writeFileSync(ssh, readFileSync(ssh, 'utf8').replace('record({ dropped: true, stdinBytes,',
    "process.stderr.write('controlled transport disconnection\\n'); record({ dropped: true, stdinBytes,"));
  box.env.PATH = `${bin}:${box.env.PATH}`;
  const runner = { host: `${HOST}-drop`, slots: 1, browser: 0, node: process.execPath };
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({
    gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true }, runners: [runner],
  }));
  return { ...box, requests, starts, runner };
}

/** Execute the current implementation inside the fixture's own environment and retain an actionable assertion. */
function child(box, source) {
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 90_000,
  });
  process.stderr.write(result.stderr??'');
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


const marker = "process.stderr.write('READY_PHASE '+JSON.stringify({phase:PLACEHOLDER,ns:process.hrtime.bigint().toString()})+String.fromCharCode(10));";
/** Add observations only, before pinning the private installed bytes through ordinary Git. */
function instrument(root) {
  const path=join(root,'src/runners.js');
  let source=readFileSync(path,'utf8');
  const add=(needle,phase,after=false)=>{
    assert.ok(source.includes(needle),needle);
    const note=marker.replace('PLACEHOLDER',JSON.stringify(phase));
    source=source.replace(needle,after?needle+'\n'+note:note+'\n'+needle);
  };
  add('runner = validateRunner(runner);','request.validate');
  add('const current = runnerSource(root);','request.source',true);
  add('const tags = candidateTags(root, selected);','request.history',true);
  add('const { worker, tooling, runtime } = trustedTooling();','tooling.begin');
  add('const { worker, tooling, runtime } = trustedTooling();','tooling.end',true);
  add("const child = spawn('ssh', request.args,",'ssh.spawn');
  const scan=source.includes('const { entry, files } = loadedToolingFiles();')?'const { entry, files } = loadedToolingFiles();':'const files = loadedToolingFiles();';
  if(source.includes(scan)) add(scan,'tooling.loaded',true);
  add("const manifest = JSON.parse(readFileSync(join(TOOL_ROOT, 'package.json'), 'utf8'));",'tooling.secret-scan.end');
  writeFileSync(path,source);
  const packagePath=join(root,'src/runner-package.js');
  if(existsSync(packagePath)) {
    let text=readFileSync(packagePath,'utf8');
    text=text.replace('function derivePackage(root, entry, previous, parse) {','function derivePackage(root, entry, previous, parse) {\n'+marker.replace('PLACEHOLDER',"'derive.begin'"));
    text=text.replace("manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));","manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));\n"+marker.replace('PLACEHOLDER',"'derive.package.end'"));
    text=text.replace('  return { runtime: { entry, files:',marker.replace('PLACEHOLDER',"'derive.end'")+'\n  return { runtime: { entry, files:');
    writeFileSync(packagePath,text);
  }
  const parserPath=join(root,'src/runner-module-parser.js');
  if(existsSync(parserPath)) {
    let text=readFileSync(parserPath,'utf8');
    text=text.replace('function parse(sources) {','function parse(sources) {\n'+marker.replace('PLACEHOLDER',"'parser.begin'"));
    text=text.replace('    } finally {','    } finally {\n'+marker.replace('PLACEHOLDER',"'parser.end'"));
    writeFileSync(parserPath,text);
  }
}
for(const [index,version] of ['accepted','candidate','candidate','accepted'].entries()) {
  test(`cold ${index+1} ${version} original READY admission diagnostic [C7]`,t=>{
    t.diagnostic(JSON.stringify({index,version,order:'accepted/candidate/candidate/accepted',cold:'fresh installed bytes and controller process for every case'}));
    const implementation=mkdtempSync(join(tmpdir(),'pullboard-ready-timing-'));
    t.after(()=>rmSync(implementation,{recursive:true,force:true}));
    if(version==='candidate') copyPackageFiles(new URL('../',import.meta.url).pathname,implementation);
    else {
      const archive=execFileSync('git',['archive','8738fa3dc22a42a3b26dc17121558ec34772b5eb'],{cwd:new URL('../',import.meta.url),maxBuffer:256*1024*1024});
      const extraction=spawnSync('tar',['-x','-C',implementation],{input:archive,encoding:'utf8'});
      assert.equal(extraction.status,0,extraction.stderr);
    }
    instrument(implementation);
    const gitEnv={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Diagnostic',GIT_AUTHOR_EMAIL:'diagnostic@example.invalid',GIT_COMMITTER_NAME:'Diagnostic',GIT_COMMITTER_EMAIL:'diagnostic@example.invalid'};
    for(const args of [['init','-q'],['add','.'],['commit','-q','-m','diagnostic immutable installed source']]) execFileSync('git',args,{cwd:implementation,env:gitEnv,stdio:'pipe'});
  const box = fixture(t, { dropFirst: false });
  const ssh = join(box.dir, 'transport-bin', 'ssh');
  const before = readFileSync(ssh, 'utf8');
  const dispatch = "if (hold === 'dispatch') await holdHere();";
  assert.ok(before.includes(dispatch), 'the private stand-in exposes the real dispatch phase');
  // The actual configured Node probe still answers; only a framed worker dispatch never reaches READY.
  writeFileSync(ssh, before.replace(dispatch, 'if (remoteCommand.startsWith(configuredNode)) await holdHere();'));
  const settings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const configured = JSON.parse(readFileSync(settings, 'utf8'));
  writeFileSync(settings, JSON.stringify({ ...configured, gate: { ...configured.gate, runnerWaitMs: 1_000 } }));
  const gate = pathToFileURL(join(implementation, 'src/gate.js')).href;
  const transport = pathToFileURL(join(implementation, 'src/runner-transport.js')).href;
  const recovery = pathToFileURL(join(implementation, 'src/runner-recovery.js')).href;
  const result = child(box, `import {withGateSlot,runProfiledShellAsync} from ${JSON.stringify(gate)};
    import {probeRunnerTransport} from ${JSON.stringify(transport)};
    import {recoverUnavailableRunners} from ${JSON.stringify(recovery)};
    import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
    console.error('READY_PHASE '+JSON.stringify({phase:'admission.begin',ns:process.hrtime.bigint().toString()}));
    let code;try{await withGateSlot(process.cwd(),lease=>{console.error('READY_PHASE '+JSON.stringify({phase:'lease.admitted',ns:process.hrtime.bigint().toString(),deadline:lease.runnerWaitDeadline}));return runProfiledShellAsync(process.cwd(),'true',{gateLease:lease});},
      {remote:true,onWait(){}});}catch(error){code=error.code;if(code!=='RUNNER_WAIT_DEADLINE')throw error;}
    const attempts=readFileSync(${JSON.stringify(box.starts)},'utf8').trim().split('\\n').length;
    const health=await probeRunnerTransport(${JSON.stringify(box.runner)});
    const db=new DatabaseSync(process.env.PULLBOARD_MACHINE_HOME+'/resources.sqlite');
    const held=db.prepare('SELECT * FROM runner_unavailable').get();
    let automaticProbes=0;
    const recovered=await recoverUnavailableRunners(db,[${JSON.stringify(box.runner)}],{
      probe:async()=>{automaticProbes++;return {healthy:true};}});
    const remaining=db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n;
    const leases=db.prepare('SELECT (SELECT COUNT(*) FROM holder)+(SELECT COUNT(*) FROM waiter) n').get().n;
    console.log(JSON.stringify({code,attempts,health:health.healthy,detail:held?.detail,
      reason:held?JSON.parse(held.failure).original.reason:null,recovered,automaticProbes,remaining,leases}));db.close();`);
  assert.equal(result.code, 'RUNNER_WAIT_DEADLINE', 'disabled local capacity is never invented as a fallback');
  assert.equal(result.attempts, 1, 'the timed-out job gets neither another dispatch nor a substitute health retry');
  assert.equal(result.health, true, 'a real standalone configured Node process answers on this same host');
  assert.equal(result.detail, 'WORKER_UNRESPONSIVE');
  assert.equal(result.reason, 'admission-deadline');
  assert.equal(result.recovered, false, 'SSH health does not prove worker readiness recovered');
  assert.equal(result.automaticProbes, 0);
  assert.equal(result.remaining, 1);
  assert.equal(result.leases, 0, 'the failed run leaves no private holder or waiter');

  });
}
