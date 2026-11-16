/** Actual SSH protocol failures retain evidence and recover through the shared queue [C7]. */
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { preparedRunner } from '../../../../packages/runners/tests/fixtures/prepared.js';
import { initializeRunnerRecovery } from '../../../../packages/resources/index.js';

/** Build a real private project and a private SSH executable; no configured machine host is contacted. */
function fixture(t, { dropFirst = true } = {}) {
  const e2e = createE2eHelpers(); t.after(e2e.cleanup);
  const box = e2e.project('true');
  const bin = join(box.dir, 'transport-bin');
  const { worker, home, machineHome } = preparedRunner(() => privateFixtureFiles('pullboard-prepared-runner-').root);
  for (const folder of [bin, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  const requests = join(box.dir, 'requests.jsonl'), starts = join(box.dir, 'starts.jsonl');
  installSshStandIn({ bin, worker, home, machineHome, requests, starts, dropFirst, nodeCommand: process.execPath });
  const ssh = join(bin, 'ssh');
  writeFileSync(ssh, readFileSync(ssh, 'utf8').replace('record({ dropped: true, stdinBytes,',
    "process.stderr.write('controlled transport disconnection\\n'); record({ dropped: true, stdinBytes,"));
  box.env.PATH = `${bin}:${box.env.PATH}`;
  const runner = { host: `${HOST}-drop`, slots: 1, browser: 0, node: process.execPath };
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({
    gateSlots: 0, browserSlots: 0, runners: [runner],
    // Live-load ranking probes each runner over SSH before admission, which the holding stand-ins below would stall past the deadline.
    gate: { runnersFirst: true, loadAwareDispatch: false },
  }));
  return { ...box, requests, starts, runner };
}

/** Execute the current implementation inside the fixture's own environment and retain an actionable assertion. */
function child(box, source) {
  // Process-level: a fresh node process proves the module graph loads without the CLI seam.
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

// PULLBOARD_LOST_CASES ('ssh', 'held', 'held:yield' or 'held:retry') picks one group of cases, so the journeys can run in
// separate files inside the file budget [#6734,#6917]; 'held' takes both held cases; unset runs the ssh case, the held
// cases being lost.pull.held and lost.pull.retry (the controller dispatch that ran them all in one file is gone, #5821).
const only = process.env.PULLBOARD_LOST_CASES ?? 'ssh';
const caseTest = (group, ...args) => (!only || only === group || group.startsWith(`${only}:`) ? test(...args) : undefined);

// The SSH controller serves only pull modes since #9054, so a synchronous call ends in its refusal, not in the stand-in's 255.
caseTest('ssh', 'a synchronous runner call is refused by the retired SSH controller and keeps its exit and stderr [C7]', t => {
  const box = fixture(t);
  const url = pathToFileURL(join(import.meta.dirname, '../../../../packages/runners/index.js')).href;
  const result = child(box, `import {runOnRunner} from ${JSON.stringify(url)};
    try {runOnRunner(process.cwd(),'true',{runner:${JSON.stringify(box.runner)}});process.exitCode=1;}
    catch(error){console.log(JSON.stringify({name:error.name,diagnostic:error.diagnostic}));}`);
  assert.equal(result.name, 'RunnerDropped');
  assert.equal(result.diagnostic.exitCode, 1);
  assert.equal(result.diagnostic.reason, 'bridge-json');
  assert.match(result.diagnostic.stderr, /SSH runner controller is retired/u);
});

// Test-only boot budget: gate.runnerWaitMs runs from the request, so under load a 1000 ms deadline can expire before
// the SSH stand-in's own Node process boots and no start is recorded (3 of 12 concurrent runs red on 28 Oct, 4/4 green
// alone). 8000 ms is the measured headroom; the product deadline is unchanged and every assertion below is kept.
// Pull dispatch boots the stand-in for each enqueue and agent script, so under runner load it needs 15 s: past 8 s the
// lease is admitted late with a 90 s startup budget and the 90 s child timeout fires first (lost.pull, #6734). The held
// first dispatch waits this budget out before failing over, then the second dispatch (a controller boot, the pack and
// the job) needs up to 57 s on a loaded runner, so 30 s here left no margin inside the 90 s child timeout (#7090).
const STAND_IN_BOOT_BUDGET_MS = 15_000;

caseTest('held:yield', 'a worker missing READY yields to a free runner in the next admission cycle [C7,Q1,Q2]', t => {
  const box = fixture(t, { dropFirst: false });
  const ssh = join(box.dir, 'transport-bin', 'ssh');
  const before = readFileSync(ssh, 'utf8');
  const dispatch = "if (hold === 'dispatch') await holdHere();";
  assert.ok(before.includes(dispatch));
  writeFileSync(ssh, before.replace(dispatch,
    `if (host === ${JSON.stringify(box.runner.host)} && launchesWorker) await holdWorker();`));
  const settings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const configured = JSON.parse(readFileSync(settings, 'utf8'));
  const second = { ...box.runner, host: HOST + '-setup' };
  writeFileSync(settings, JSON.stringify({ ...configured, runners: [box.runner, second],
    gate: { ...configured.gate, timingRunner: false, runnerWaitMs: STAND_IN_BOOT_BUDGET_MS } }));
  const gate = pathToFileURL(join(import.meta.dirname, '../../../../packages/gate/index.js')).href;
  const result = child(box, `import {withGateSlot,runProfiledShellAsync} from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
    import {DatabaseSync} from 'node:sqlite';
    const attempts=[],notices=[],waits=[];
    const run=await withGateSlot(process.cwd(),lease=>{
      attempts.push(lease.runner.host);
      return runProfiledShellAsync(process.cwd(),'node -e "console.log(\\'READY_FAILOVER_EXECUTED\\')"',{gateLease:lease});
    },{executionServices,remote:true,runnerOnly:true,item:'fixture',kind:'remote-command',onWait:state=>{
      if(state.runnerUnavailable)notices.push(state.runnerUnavailable);
      else if(!state.admitted)waits.push(state);
    }});
    const db=new DatabaseSync(process.env.PULLBOARD_MACHINE_HOME+'/resources.sqlite',{readOnly:true});
    const held=db.prepare('SELECT host,detail FROM runner_unavailable').all();db.close();
    console.log(JSON.stringify({green:run.isGreen,output:run.output,attempts,notices,waits,held}));`);
  assert.equal(result.green, true);
  assert.match(result.output, /READY_FAILOVER_EXECUTED/u);
  assert.deepEqual(result.attempts, [box.runner.host, second.host], 'the command executes on the second actual SSH worker');
  assert.equal(result.waits.length, 0, 'failover admits in the next cycle instead of waiting for another budget');
  assert.equal(result.notices[0].host, box.runner.host);
  assert.match(result.notices[0].reason, /worker did not become ready/u);
  assert.deepEqual(result.held, [], 'a runner that answers SSH and Node stays in service rather than held (#3738)');
});

caseTest('held:retry', 'an SSH-healthy host whose worker misses READY once stays in service and its job retries there (#3738) [C7]', t => {
  const box = fixture(t, { dropFirst: false });
  const ssh = join(box.dir, 'transport-bin', 'ssh');
  const before = readFileSync(ssh, 'utf8');
  const dispatch = "if (hold === 'dispatch') await holdHere();";
  assert.ok(before.includes(dispatch), 'the private stand-in exposes the real dispatch phase');
  // The actual configured Node probe still answers; only the first framed worker dispatch never reaches READY.
  const missed = join(box.dir, 'missed-ready');
  writeFileSync(ssh, before.replace(dispatch,
    `if (launchesWorker && !existsSync(${JSON.stringify(missed)})) { appendFileSync(${JSON.stringify(missed)}, 'x'); await holdWorker(); }`));
  const settings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const configured = JSON.parse(readFileSync(settings, 'utf8'));
  writeFileSync(settings, JSON.stringify({ ...configured, gate: { ...configured.gate, runnerWaitMs: STAND_IN_BOOT_BUDGET_MS } }));
  const gate = pathToFileURL(join(import.meta.dirname, '../../../../packages/gate/index.js')).href;
  // The second miss (RUNNER_WAIT_DEADLINE, runner still in service) waits out the 90 s late-dispatch budget, so packages/gate/tests/runner/probe.test.js owns it.
  const result = child(box, `import {withGateSlot,runProfiledShellAsync} from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
    import {DatabaseSync} from 'node:sqlite';
    const attempts=[];
    const run=await withGateSlot(process.cwd(),lease=>{
      attempts.push(lease.runner.host);
      return runProfiledShellAsync(process.cwd(),'node -e "console.log(\\'RETRY_EXECUTED\\')"',{gateLease:lease});
    },{executionServices,remote:true,runnerOnly:true,item:'fixture',kind:'remote-command',onWait(){}});
    const db=new DatabaseSync(process.env.PULLBOARD_MACHINE_HOME+'/resources.sqlite',{readOnly:true});
    const held=db.prepare('SELECT host,detail FROM runner_unavailable').all();
    const leases=db.prepare('SELECT (SELECT COUNT(*) FROM holder)+(SELECT COUNT(*) FROM waiter) n').get().n;db.close();
    console.log(JSON.stringify({green:run.isGreen,output:run.output,attempts,held,leases}));`);
  assert.equal(result.green, true, 'the retry on the same healthy runner runs the job');
  assert.match(result.output, /RETRY_EXECUTED/u);
  assert.deepEqual(result.attempts, [box.runner.host, box.runner.host], 'one missed READY, then one retry on the runner that answered SSH');
  assert.deepEqual(result.held, [], 'a runner that answers SSH and Node is never held for a missed READY (#3738)');
  assert.equal(result.leases, 0, 'the finished run leaves no private holder or waiter');
});

