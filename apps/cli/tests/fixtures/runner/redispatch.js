/** @pullboard-test-input packages/gate/index.js packages/resources/index.js */
/** @pullboard-test-loads packages/resources/index.js */
/** @pullboard-test-loads packages/resources/index.js */
/** A runner quarantined before READY releases its lease for one healthy dispatch [C7,H16]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createE2eHelpers } from '../e2e.js';
import { runFixtureChild } from '../child.js';
import {
  installSshStandIn,
  HOST,
} from './ssh.js';
import { executionServicesSource } from '../gate/execution.js';

const FIRST = { host: HOST, slots: 1, browser: 0 };
const SECOND = { host: `${HOST}-setup`, slots: 1, browser: 0 };

/** Resolve the implementation loaded by the real private controller. */
const sourceURL = file => pathToFileURL(join(import.meta.dirname, '../../../../..', file)).href;

/** Run the actual gate/controller against two private SSH stand-ins and one private resources DB. */
function fixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const sandbox = helpers.sandbox();
  sandbox.env.PULLBOARD_MODEL = 'Test Model';
  const box = helpers.project('true', sandbox, { withWorktree: false });
  const bin = join(box.dir, 'ssh-bin'), worker = join(box.dir, 'worker');
  const home = join(box.dir, 'remote-home'), machineHome = join(home, '.pullboard');
  const first = { ...FIRST, node: process.execPath, root: join(box.dir, 'remote-root') };
  const second = { ...SECOND, node: process.execPath, root: join(box.dir, 'remote-root-second') };
  const localMachineHome = box.env.PULLBOARD_MACHINE_HOME;
  const requests = join(box.dir, 'requests.jsonl'), starts = join(box.dir, 'starts.jsonl');
  for (const path of [bin, worker, home, machineHome]) mkdirSync(path, { recursive: true });
  const ssh = installSshStandIn({ bin, worker, home, machineHome, requests, starts,
    nodeCommand: process.execPath, hold: 'dispatch' });
  // Hold only the first configured host before it can send READY; the healthy second host runs normally.
  const standIn = readFileSync(ssh, 'utf8');
  const held = `const hold = registrationGuiProbe || workerHealthProbe ? '' : ${JSON.stringify('dispatch')};`;
  assert.ok(standIn.includes(held), 'the fixture stand-in has its expected bounded dispatch hold');
  writeFileSync(ssh, standIn.replace(held,
    `const hold = registrationGuiProbe || workerHealthProbe ? '' : host === ${JSON.stringify(FIRST.host)} ? 'dispatch' : '';`), { mode: 0o700 });
  sandbox.env.PATH = `${bin}:${sandbox.env.PATH}`;
  const settings = join(localMachineHome, 'settings.json');
  mkdirSync(localMachineHome, { recursive: true });
  writeFileSync(settings, JSON.stringify({ gateSlots: 0, browserSlots: 0,
    gate: { runnersFirst: true }, runners: [first] }));
  return { ...box, first, second, requests, starts, settings };
}

/** Register a real pre-READY quarantine/requeue case without starting a nested test command. */
export function registerRunnerUnavailableRedispatchTests() {
  test('a pre-READY unavailable runner releases its lease and dispatches once to a healthy runner [C7,H16]', async t => {
    const box = fixture(t), gate = sourceURL('packages/gate/index.js'), recovery = sourceURL('packages/resources/index.js');
    const source = `import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recordRunnerFailure } from ${JSON.stringify(recovery)};
import { withGateSlot, runProfiledShellAsync } from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
const root=${JSON.stringify(box.repo)}, settings=${JSON.stringify(box.settings)};
const starts=${JSON.stringify(box.starts)}, requests=${JSON.stringify(box.requests)};
const first=${JSON.stringify(box.first)}, second=${JSON.stringify(box.second)};
const command=${JSON.stringify("node -e 'process.stdout.write(\"healthy-second-executed\")'")};
/** Quarantine only after this first action's real owned transport reached dispatch. */
async function quarantineAfterDispatch(){
const startDeadline=Date.now()+8000;
while(Date.now()<startDeadline&&!existsSync(starts))await new Promise(resolve=>setTimeout(resolve,20));
assert.ok(existsSync(starts),'first runner reached the controlled pre-READY SSH hold');
const firstStart=JSON.parse(readFileSync(starts,'utf8').trim().split('\\n')[0]);
assert.equal(firstStart.host,first.host);
const db=new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME,'resources.sqlite'));
try {
  const held=db.prepare('SELECT controller_identity FROM holder WHERE runner=?').all(first.host);
  assert.equal(held.length,1,'unavailability arrives while the first job owns its slot');
  assert.ok(JSON.parse(held[0].controller_identity).controllerPid,'the real controller registered custody');
  recordRunnerFailure(db,first.host,'cleanup-unverified',{reason:'fixture unavailable before READY'});
}
finally { db.close(); }
}
const actionHosts=[],firstErrors=[],unavailable=[];
let finalRun;
await withGateSlot(root,async lease=>{
  assert.ok(lease.runner,'runner-only fixture never falls back locally');
  actionHosts.push(lease.runner.host);
  try {
    const running=runProfiledShellAsync(root,command,{gateLease:lease});
    if(actionHosts.length===1){
      const [execution,observation]=await Promise.allSettled([running,quarantineAfterDispatch()]);
      if(observation.status==='rejected')throw observation.reason;
      if(execution.status==='rejected')throw execution.reason;
      finalRun=execution.value;
    }else finalRun=await running;
    return finalRun;
  }
  catch(error) { firstErrors.push({code:error.code,diagnostic:error.diagnostic}); throw error; }
},{executionServices,remote:true,runnerOnly:true,kind:'test',runnerWaitMs:12000,onWait(state){
  if(!state.runnerUnavailable)return;
  unavailable.push(state.runnerUnavailable);
  const config=JSON.parse(readFileSync(settings,'utf8'));
  if(!config.runners.some(row=>row.host===second.host)){
    config.runners.push(second);
    writeFileSync(settings,JSON.stringify(config));
  }
}});
assert.deepEqual(actionHosts,[first.host,second.host],'only one bounded requeue changes runner');
assert.equal(firstErrors.length,1);
assert.equal(firstErrors[0].code,'RUNNER_UNAVAILABLE','the first controller must observe unavailable before READY');
assert.equal(firstErrors[0].diagnostic.remoteCleanup,'unknown');
assert.equal(unavailable.length,1);
assert.equal(unavailable[0].host,first.host);
assert.equal(finalRun.isGreen,true,'the real healthy worker receipt is green');
assert.equal(finalRun.output.match(/healthy-second-executed/gu)?.length,1,'healthy command executes exactly once');
const dispatches=readFileSync(requests,'utf8').trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line));
assert.equal(dispatches.filter(row=>row.host===second.host&&row.workerStarted===true&&row.remoteStartsWithConfiguredNode===true).length,1,
  'the second runner completed exactly one real worker execution');
const check=new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME,'resources.sqlite'),{readOnly:true});
try {
  assert.equal(check.prepare('SELECT detail FROM runner_unavailable WHERE host=?').get(first.host).detail,'CLEANUP_UNVERIFIED');
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM holder').get().n,0,'the retry released its gate holder');
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM waiter').get().n,0,'the retry left no queued waiter');
} finally { check.close(); }
console.log(JSON.stringify({actionHosts,firstCode:firstErrors[0].code,secondExecutions:1,remoteCleanup:'unknown'}));`;
    const env = { ...box.env };
    delete env.NODE_TEST_CONTEXT;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source],
      { cwd: box.repo, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).actionHosts, [FIRST.host, SECOND.host]);
  });
}
