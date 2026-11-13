/** Runner dispatch generation guards and late-start budget after a lost SSH call [C7]. Split from lost.recovery.test.js. All four cases call the controller transport (runOnRunnerAsync/withGateSlot) directly, which #6579 deletes, so each is skipped CONTROLLER_ONLY. */
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
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


// Test-only boot budget: the SSH stand-in's own Node process must boot before gate.runnerWaitMs expires under load.
const STAND_IN_BOOT_BUDGET_MS = 8_000;

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
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, {
    gateSlots: 0, browserSlots: 0, runners: [runner],
    // Live-load ranking probes each runner over SSH before admission, which the holding stand-ins below would stall past the deadline.
    gate: { runnersFirst: true, loadAwareDispatch: false },
  });
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
test('a controller and worker mixed across an upgrade are refused before SSH while a fresh controller works [C7]', { skip: 'CONTROLLER_ONLY: deleted with #6579' }, t => {
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

test('a changed composed resource provider leaf refuses the old controller generation before SSH [C7]', { skip: 'CONTROLLER_ONLY: deleted with #6579' }, t => {
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

test('an asynchronous runner dispatch never uses a preloaded resource generation [C7]', { skip: 'CONTROLLER_ONLY: deleted with #6579' }, t => {
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


test('a dispatch after the lease queue deadline gets its full startup budget and reaches READY first time [C7]', { skip: 'CONTROLLER_ONLY: deleted with #6579' }, t => {
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
