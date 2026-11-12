/** Actual SSH protocol failures retain evidence and recover through the shared queue [C7]. */
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import { runnerLossHealth } from '../../src/logic/runner/loss.js';
import { runnerLossLines } from '../../src/logic/runner/loss.js';
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
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { toolSourcePath } from '../../../../packages/runners/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';
import { initializeRunnerRecovery } from '../../../../packages/resources/index.js';
import { recordRunnerFailure } from '../../../../packages/resources/index.js';
import { recoverUnavailableRunners } from '../../../../packages/resources/index.js';

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
    gateSlots: 0, browserSlots: 0, runners: [runner],
    // Live-load ranking probes each runner over SSH before admission, which the holding stand-ins below would stall past the deadline.
    gate: { runnersFirst: true, loadAwareDispatch: false, runnerDispatch: process.env.PULLBOARD_FIXTURE_DISPATCH ?? 'controller' },
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

/** Synthetic queue identities exercise generation guards, never certify an actual worker. */
function recoveryIdentity() { return { version: 1, request: randomUUID(), nonce: randomUUID(), tooling: 'a'.repeat(64) }; }

/** A real SQLite queue containing only this test's health generations. */
function queue(t) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL); CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)");
  initializeRunnerRecovery(db); t.after(() => db.close());
  return db;
}

test('a failed SSH call preserves its command exit and stderr through the synchronous bridge [C7]', t => {
  const box = fixture(t);
  const url = pathToFileURL(join(import.meta.dirname, '../../../../packages/runners/index.js')).href;
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
  const url = pathToFileURL(join(import.meta.dirname, '../../../../packages/gate/index.js')).href;
  const command = `node -e 'console.log("RECOVERED_EXECUTION")'`;
  const result = child(box, `import {withGateSlot,runProfiledShellAsync} from ${JSON.stringify(url)};
${executionServicesSource(url)}
    import {DatabaseSync} from 'node:sqlite';
    const run=await withGateSlot(process.cwd(),lease=>runProfiledShellAsync(process.cwd(),
      ${JSON.stringify(command)},{gateLease:lease}),{ executionServices,remote:true,onWait(){}});
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

// Test-only boot budget: gate.runnerWaitMs runs from the request, so under load a 1000 ms deadline can expire before
// the SSH stand-in's own Node process boots and no start is recorded (3 of 12 concurrent runs red on 28 Oct, 4/4 green
// alone). 8000 ms is the measured headroom; the product deadline is unchanged and every assertion below is kept.
const STAND_IN_BOOT_BUDGET_MS = 8_000;

test('a worker missing READY yields to a free runner in the next admission cycle [C7,Q1,Q2]', t => {
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
    },{executionServices,remote:true,runnerOnly:true,onWait:state=>{
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

test('an SSH-healthy host whose worker misses READY once stays in service and its job retries there (#3738) [C7]', t => {
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
    },{executionServices,remote:true,runnerOnly:true,onWait(){}});
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

test('a recovered runner is cleared on its first successful probe instead of a five minute expiry [C7]', async t => {
  const db = queue(t), runner = { host: 'private-recovery-host', slots: 1, browser: 0 };
  const original = { command: ['ssh', runner.host, '[worker]'], exitCode: 255, stderr: 'controlled connection failure', recovery: recoveryIdentity() };
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

test('real pinned worker recovery clears the transport row within seconds [C7]', t => {
  const box = fixture(t);
  const runner = { ...box.runner, host: HOST };
  const recovery = pathToFileURL(join(import.meta.dirname, '../../../../packages/resources/index.js')).href;
  const transport = pathToFileURL(join(import.meta.dirname, '../../../../packages/runners/index.js')).href;
  const result = child(box, `import {DatabaseSync} from 'node:sqlite';
    import {initializeRunnerRecovery,recordRunnerFailure,recoverUnavailableRunners} from ${JSON.stringify(recovery)};
    import {probeRunnerTransport} from ${JSON.stringify(transport)};
    import {runOnRunnerAsync,probeRunnerHealth} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../packages/runners/index.js')).href)};
    import {readdirSync,readFileSync} from 'node:fs';
    const runner=${JSON.stringify(runner)},db=new DatabaseSync(':memory:');
    db.exec("CREATE TABLE runner_unavailable(host TEXT PRIMARY KEY,since TEXT NOT NULL,detail TEXT NOT NULL);CREATE TABLE runner_draining(host TEXT PRIMARY KEY,runner TEXT NOT NULL)");
    initializeRunnerRecovery(db);
    const completed=await runOnRunnerAsync(process.cwd(),'true',{runner});if(!completed.isGreen)throw new Error('real cleanup control failed');
    const directory=${JSON.stringify(join(box.dir, 'worker-home', '.pullboard-runner', 'recovery'))};
    const completion=JSON.parse(readFileSync(directory+'/'+readdirSync(directory)[0],'utf8'));
    const bad=await probeRunnerTransport({...runner,node:${JSON.stringify(join(box.dir, 'missing-configured-node'))}});
    recordRunnerFailure(db,runner.host,'transport-lost',{command:bad.command,exitCode:bad.code,reason:bad.reason,recovery:completion});
    db.prepare('UPDATE runner_unavailable SET probe_after=0').run();
    const started=Date.now(),recovered=await recoverUnavailableRunners(db,[runner],{probe:probeRunnerHealth});
    console.log(JSON.stringify({bad,recovered,elapsed:Date.now()-started,remaining:db.prepare('SELECT COUNT(*) n FROM runner_unavailable').get().n}));db.close();`);
  assert.equal(result.bad.healthy, false);
  assert.equal(result.bad.code, 127);
  assert.equal(result.recovered, true);
  assert.equal(result.remaining, 0);
  assert.ok(result.elapsed < RECOVERY_BOUND_MS, `observed recovery took ${result.elapsed}ms`); // budget: derived from the 3s probe ceiling, 0.5s drain and local process startup.
});

test('concurrent recovery probes cannot clear a newer transport failure or cleanup hold [C7]', async t => {
  const db = queue(t), runner = { host: 'private-generation-host', slots: 1, browser: 0 };
  recordRunnerFailure(db, runner.host, 'transport-lost', { reason: 'first', recovery: recoveryIdentity() });
  db.prepare('UPDATE runner_unavailable SET probe_after=0').run();
  let finish, called = 0;
  const pending = recoverUnavailableRunners(db, [runner], { probe: () => { called++; return new Promise(resolve => { finish = resolve; }); } });
  assert.equal(await recoverUnavailableRunners(db, [runner], { probe: async () => { called++; return { healthy: true }; } }), false);
  assert.equal(called, 1, 'the shared row admits one observing client');
  recordRunnerFailure(db, runner.host, 'cleanup-unverified', { reason: 'new cleanup uncertainty', recovery: recoveryIdentity() });
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

test('a controller and worker mixed across an upgrade are refused before SSH while a fresh controller works [C7]', t => {
  const box = fixture(t), installed = join(box.dir, 'installed-tooling');
  mkdirSync(installed);
  copyPackageFiles(join(import.meta.dirname, '../../../..'), installed);
  const url = pathToFileURL(join(installed, 'packages/runners/index.js')).href;
  const result = child(box, `import {runOnRunnerAsync} from ${JSON.stringify(url)};
    import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    const worker=${JSON.stringify(join(installed, 'apps/runner/src/io/scripts/worker.js'))};
    // The upgrade lands after this controller loaded: the worker on disk is newer than the controller's pinned bytes.
    writeFileSync(worker,readFileSync(worker,'utf8')+'\\n// upgraded worker generation\\n');
    let failure;
    try {await runOnRunnerAsync(process.cwd(),'true',{runner:${JSON.stringify({ ...box.runner, host: HOST })}});process.exitCode=1;}
    catch(error){failure={name:error.name,code:error.code,diagnostic:error.diagnostic};}
    console.log(JSON.stringify({...failure,sentBeforeFresh:existsSync(${JSON.stringify(box.requests)})}));`);
  // A fresh controller process loads the upgraded controller and worker together, so the pair is coherent.
  const fresh = child(box, `import {runOnRunnerAsync} from ${JSON.stringify(url)};
    const valid=await runOnRunnerAsync(process.cwd(),'true',{runner:${JSON.stringify({ ...box.runner, host: HOST })}});
    console.log(JSON.stringify({freshGreen:valid.isGreen}));`);
  result.freshGreen = fresh.freshGreen;
  assert.equal(result.name, 'Refused');
  assert.equal(result.code, 'RUNNER_TOOLING_CHANGED');
  assert.equal(result.sentBeforeFresh, false, 'no host is contacted or quarantined for a stale controller');
  assert.equal(result.freshGreen, true, 'both upgraded allowlists are coherent when loaded by a fresh controller');
});

test('a changed composed resource provider leaf refuses the old controller generation before SSH [C7]', t => {
  const box = fixture(t, { dropFirst: false }), installed = join(box.dir, 'installed-lifecycle-tooling');
  mkdirSync(installed);
  copyPackageFiles(join(import.meta.dirname, '../../../..'), installed);
  const url = pathToFileURL(join(installed, 'packages/runners/index.js')).href;
  const leaf = join(installed, 'packages/resources/src/io/controller/custody.js');
  const result = child(box, `import {runOnRunnerAsync} from ${JSON.stringify(url)};
    import {existsSync,readFileSync,writeFileSync} from 'node:fs';
    const leaf=${JSON.stringify(leaf)};
    writeFileSync(leaf,readFileSync(leaf,'utf8')+'\\n// private lifecycle provider generation changed\\n');
    let failure;
    try {await runOnRunnerAsync(process.cwd(),'true',{runner:${JSON.stringify({ ...box.runner, host: HOST })}});}
    catch(error){failure={name:error.name,code:error.code};}
    console.log(JSON.stringify({failure,sent:existsSync(${JSON.stringify(box.requests)})}));`);
  assert.equal(result.failure?.name, 'Refused');
  assert.equal(result.failure?.code, 'RUNNER_TOOLING_CHANGED');
  assert.equal(result.sent, false, 'a stale lifecycle provider cannot contact or quarantine a host');
});

test('an asynchronous runner dispatch never uses a preloaded resource generation [C7]', t => {
  const box = fixture(t, { dropFirst: false }), installed = join(box.dir, 'installed-preloaded-tooling');
  mkdirSync(installed);
  copyPackageFiles(join(import.meta.dirname, '../../../..'), installed);
  const observations = join(box.dir, 'resource-generation.jsonl');
  const resources = toolSourcePath(installed, 'packages/resources/src/io/main.js');
  const signature = 'export function recordRunnerGui(host, gui) {';
  const observer = `\n  observeGeneration(${JSON.stringify(observations)}, JSON.stringify({ pid: process.pid, generation: 'resource-generation-before' }) + '\\n');`;
  const original = readFileSync(resources, 'utf8');
  assert.ok(original.includes(signature), 'the observer instruments the actual GUI receipt callback');
  writeFileSync(resources, "import { appendFileSync as observeGeneration } from 'node:fs';\n" + original.replace(signature, signature + observer));
  const url = pathToFileURL(join(installed, 'packages/runners/index.js')).href;
  const result = child(box, `
    import {readFileSync,writeFileSync} from 'node:fs';
    await import(${JSON.stringify(pathToFileURL(resources).href)});
    const resourceFile=${JSON.stringify(resources)};
    writeFileSync(resourceFile,readFileSync(resourceFile,'utf8').replace('resource-generation-before','resource-generation-after'));
    const {runOnRunnerAsync}=await import(${JSON.stringify(url)});
    const run=await runOnRunnerAsync(process.cwd(),'true',{runner:${JSON.stringify({ ...box.runner, host: HOST })}});
    console.log(JSON.stringify({green:run.isGreen,parentPid:process.pid,observations:readFileSync(${JSON.stringify(observations)},'utf8').trim().split('\\n').map(JSON.parse)}));`);
  assert.equal(result.green, true, 'the actual private worker returns a valid green receipt');
  assert.ok(result.observations.length > 0, 'the receipt path actually invokes the instrumented resource callback');
  assert.ok(result.observations.every(row => row.generation === 'resource-generation-after'),
    `only the upgraded callback executes: ${JSON.stringify(result.observations)}`);
  assert.ok(result.observations.every(row => row.pid !== result.parentPid),
    'execution happens in a fresh controller, outside the parent\'s preloaded module cache');
});


test('health counts distinct retained transport refusals by runner and classification without claiming a host outage [C7,C6]', () => {
  const now = Date.parse('2026-10-30T20:00:00Z');
  const loss = (runner, request, at, reason = 'admission-deadline') => ({ code: 'TRANSPORT_LOST', runner, at, diagnostic: { request, reason } });
  const first = loss('fixture-55', 'first', '2026-10-30T19:00:00Z');
  const report = runnerLossHealth([
    { infrastructureAttempts: [first, loss('fixture-55', 'second', '2026-10-30T19:01:00Z', 'receipt-count')] },
    { infrastructureAttempts: [first, loss('fixture-51', 'third', '2026-10-30T19:02:00Z')] },
    { infrastructureAttempts: [loss('fixture-old', 'old', '2026-10-29T19:59:59Z'), loss('fixture-future', 'future', '2026-10-30T20:00:01Z'),
      { ...first, code: 'RUNNER_CLEANUP_TIMEOUT', diagnostic: { request: 'cleanup' } }, { code: 'TRANSPORT_LOST', runner: null, at: 'unknown' }] },
  ], now);
  assert.deepEqual(report.runners.map(row => [row.runner, row.count]), [['fixture-55', 2], ['fixture-51', 1]]);
  assert.deepEqual({ ...report.runners[0].reasons }, { 'admission-deadline': 1, 'receipt-count': 1 });
  assert.equal(report.unlocalized, 1);
  assert.equal(report.coverage, 'retained-native-attempts-only');
  const lines = runnerLossLines(report).join('\n');
  assert.match(lines, /fixture-55: 2; admission-deadline 1, receipt-count 1/u);
  assert.match(lines, /incomplete history is possible/u);
  assert.match(lines, /not assigned to a host/u);
  assert.deepEqual(runnerLossLines(runnerLossHealth([], now)), [], 'no observed losses does not invent a healthy-host row');
});

test('actual health JSON and text expose private retained transport counts without probing a machine host [C7,C6]', async t => {
  const e2e = createE2eHelpers(); t.after(e2e.cleanup);
  const box = e2e.project('true');
  const at = new Date().toISOString();
  const record = { at, waitMs: 0, runMs: 0, infrastructureAttempts: [
    { code: 'TRANSPORT_LOST', runner: 'private-health-fixture', at, diagnostic: { request: 'private-observation', reason: 'receipt-count' } },
  ] };
  writeFileSync(join(box.repo, '.git', 'pullboard', 'gate-receipts.jsonl'), JSON.stringify(record) + '\n');
  const result = await box.runLocal(box.repo, 'health', '--json');
  assert.equal(result.code, 0, result.err + result.out);
  const report = JSON.parse(result.out).runnerTransportLosses;
  assert.deepEqual(report.runners.map(row => [row.runner, row.count]), [['private-health-fixture', 1]]);
  const text = await box.runLocal(box.repo, 'health');
  assert.match(text.out, /private-health-fixture: 1; receipt-count 1/u);
  assert.match(text.out, /retained native attempts/u);
});

test('a dispatch after the lease queue deadline gets its full startup budget and reaches READY first time [C7]', t => {
  const box = fixture(t, { dropFirst: false });
  const settings = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const configured = JSON.parse(readFileSync(settings, 'utf8'));
  writeFileSync(settings, JSON.stringify({ ...configured, gate: { ...configured.gate, runnerWaitMs: STAND_IN_BOOT_BUDGET_MS } }));
  const gate = pathToFileURL(join(import.meta.dirname, '../../../../packages/gate/index.js')).href;
  // The lease's queue deadline already passed, as after a gate's 177 s doctrine phase on that lease (#3563).
  const result = child(box, `import {withGateSlot,runProfiledShellAsync} from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
    import {DatabaseSync} from 'node:sqlite';
    const attempts=[];
    const run=await withGateSlot(process.cwd(),lease=>{
      attempts.push(lease.runner.host);
      lease.runnerWaitDeadline=Date.now()-1;
      return runProfiledShellAsync(process.cwd(),'node -e "console.log(\\'LATE_PHASE_EXECUTED\\')"',{gateLease:lease});
    },{executionServices,remote:true,runnerOnly:true,onWait(){}});
    const db=new DatabaseSync(process.env.PULLBOARD_MACHINE_HOME+'/resources.sqlite',{readOnly:true});
    const held=db.prepare('SELECT host,detail FROM runner_unavailable').all();db.close();
    console.log(JSON.stringify({green:run.isGreen,output:run.output,attempts,held}));`);
  assert.equal(result.green, true);
  assert.match(result.output, /LATE_PHASE_EXECUTED/u);
  assert.deepEqual(result.attempts, [box.runner.host], 'one dispatch, no readiness retry');
  assert.deepEqual(result.held, [], 'a healthy runner is never held for a missed READY');
});
