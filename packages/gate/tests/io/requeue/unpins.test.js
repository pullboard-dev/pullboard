/** @pullboard-test-input packages/config/index.js packages/gate/index.js packages/kernel/index.js packages/resources/index.js */
/** Quarantined execution is re-admitted across the compatible fleet with a fresh deadline [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { awaitNestedRun } from '../../../heavy.js';
import { runFixtureChildAsync } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { executionServicesSource } from '../../fixtures/execution.js';
import { HOST } from '../../fixtures/runner/ssh.js';
import { installSshStandIn } from '../../fixtures/runner/ssh.js';

/** Keep the real resource database, settings, Git source and SSH stand-in private to each case. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-requeue-unpins-'));
  const paths = Object.fromEntries(['repo', 'bin', 'home', 'machine', 'worker', 'remoteHome', 'remoteMachine'].map(name => [name, join(directory, name)]));
  for (const path of Object.values(paths)) mkdirSync(path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { PATH: `${paths.bin}:${process.env.PATH}`, HOME: paths.home, PULLBOARD_HOME: paths.home, PULLBOARD_MACHINE_HOME: paths.machine,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Requeue fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Requeue fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: paths.repo, env });
  writeFileSync(join(paths.repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(paths.repo, 'source.txt'), 'private committed source\n');
  runFixtureGit(['add', '-A'], { cwd: paths.repo, env });
  runFixtureGit(['commit', '-qm', 'test: private requeue source'], { cwd: paths.repo, env });
  const runners = [HOST, `${HOST}-setup`].map(host => ({ host, slots: 1, browser: 0, node: process.execPath }));
  writeFileSync(join(paths.machine, 'settings.json'), JSON.stringify({ gateSlots: 0, browserSlots: 0, gate: { timingRunner: false }, runners })); // #2512 keeps one of two runners for timed checks; this fixture pins and requeues across both
  return { directory, ...paths, env, runners };
}

/** Run native providers in one owned child, lending only the outer test's own slot while it waits. */
async function execute(box, source) {
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env }));
  assert.equal(result.status, 0, result.context + '\n' + result.stdout);
  return result.stdout;
}

for (const [reason, infrastructureRetryCount] of [['cleanup-unverified', 0], ['cleanup-unverified', 1], ['worker-unresponsive', 1]]) {
  test(`gate.io-requeue-unpins.retry-drops-its-host-pin-and: ${reason} retry ${infrastructureRetryCount} drops its host pin and restarts admission time [C7]`, async t => {
    const box = fixture(t);
    await execute(box, `
import assert from 'node:assert/strict';
import {takeResource,listResources} from ${JSON.stringify(new URL('../../../../resources/index.js', import.meta.url).href)};
import {gateRunnerWaitMs} from ${JSON.stringify(new URL('../../../../config/index.js', import.meta.url).href)};
const runners=${JSON.stringify(box.runners)},budget=gateRunnerWaitMs();
const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
let lease;
try {
  lease=await takeResource({name:'gate',capacity:0,root:process.cwd(),remote:true,runnerOnly:true,
    runnerProvider:()=>runners,browserCapacityProvider:()=>0,runnerWaitMs:budget,
    requiredExecutor:{kind:'ssh',host:runners[0].host},agent:'fresh-deadline-control'});
  assert.equal(lease.runner.host,runners[0].host);
  const token=lease.token,oldDeadline=lease.runnerWaitDeadline;
  // Move the controlled clock to the expired original admission, without sleeping or a timing margin.
  now=oldDeadline;lease.renew();
  lease=await lease.requeueRunner(${JSON.stringify(reason)},{quarantine:true,infrastructureRetryCount:${infrastructureRetryCount}});
  assert.equal(lease.runner.host,runners[1].host);
  assert.equal(lease.token,token,'the original ticket keeps its resource ownership');
  assert.equal(lease.runnerWaitDeadline,now+budget,'a full fresh admission budget starts at requeue');
  assert.equal(lease.lateRunnerDispatch,undefined,'this is ordinary new admission, not an expired late opportunity');
  lease.release();lease=null;
  const resources=listResources();
  assert.equal(resources.flatMap(row=>row.holders).length,0);
  assert.equal(resources.flatMap(row=>row.line).length,0);
} finally {lease?.release();Date.now=originalNow;}
`);
  });
}

test('gate.io-requeue-unpins.a-quarantined-pinned-first-runner-sends: a quarantined pinned first runner sends the real command to the free second runner [C7]', async t => {
  const box = fixture(t);
  const requests = join(box.directory, 'requests.jsonl');
  writeFileSync(join(box.bin, 'package.json'), JSON.stringify({ type: 'module' }));
  installSshStandIn({ bin: box.bin, worker: box.worker, home: box.remoteHome, machineHome: box.remoteMachine, requests });
  const gate = new URL('../../../index.js', import.meta.url).href;
  const output = await execute(box, `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {withGateSlot,runProfiledShellAsync} from ${JSON.stringify(gate)};
import {Refused} from ${JSON.stringify(new URL('../../../../kernel/index.js', import.meta.url).href)};
${executionServicesSource(gate)}
const seen=[],deadlines=[];
const completed=await withGateSlot(process.cwd(),async lease=>{
  seen.push(lease.runner.host);deadlines.push(lease.runnerWaitDeadline);
  if(seen.length===2){
    const db=new DatabaseSync(${JSON.stringify(join(box.machine, 'resources.sqlite'))},{readOnly:true});
    try {assert.ok(db.prepare('SELECT host FROM runner_unavailable WHERE host=?').get(${JSON.stringify(HOST)}),'native requeue quarantined the first runner');}
    finally {db.close();}
  }
  const result=await runProfiledShellAsync(process.cwd(),'printf real-runner-command',{gateLease:lease});
  assert.equal(result.isGreen,true,result.output);
  if(seen.length===1)throw new Refused('RUNNER_CLEANUP_TIMEOUT','controlled first-runner cleanup failure after real execution');
  return result;
},{executionServices,remote:true,runnerOnly:true,itemCheck:true,agent:'quarantine-failover',kind:'submit',item:'fixture',
  requiredExecutor:{kind:'ssh',host:${JSON.stringify(HOST)}},onWait(){}});
assert.deepEqual(seen,${JSON.stringify(box.runners.map(row => row.host))},'the failed host is not pinned on requeue');
assert.equal(completed.profile.executionRunner,seen[1]);
assert.equal(completed.output,'real-runner-command');
assert.ok(deadlines[1]>deadlines[0],'the replacement admission owns a fresh deadline');
console.log('second runner completed the real command');
`);
  assert.equal(output.trim(), 'second runner completed the real command');
});
