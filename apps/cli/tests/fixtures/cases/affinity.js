/** @pullboard-test-loads packages/resources/index.js */
/** @pullboard-test-loads packages/gate/index.js */
/** Private native admission restricts placement without granting capacity or capabilities [Q1,Q2,E27]. */
import { executionServicesSource } from '../gate/execution.js';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runFixtureChildAsync } from '../child.js';
import { createE2eHelpers } from '../e2e.js';
const RESOURCES = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/resources/index.js')).href;
const GATE = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/index.js')).href;

/** Execute only fixture-owned admission against an isolated machine database. */
async function privateAdmission(t, body) {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-affinity-'));
  const run = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { takeResource } from ${JSON.stringify(RESOURCES)};
    const runners = [{host:'fixture-a',slots:1,browser:1,gui:true},{host:'fixture-b',slots:1,browser:0,gui:false}];
    const base = {name:'gate',capacity:1,remote:true,runnerProvider:()=>runners,runnerWaitMs:5000};
    const held = [];
    const take = async options => {const lease=await takeResource({...base,...options});held.push(lease);return lease;};
    try { ${body} } finally {for(const lease of held) lease.release();}
  `], { env: { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: home } });
  let finished = false;
  run.then(() => { finished = true; });
  t.after(async () => {
    if (!finished) run.child.kill('SIGTERM');
    await run;
    rmSync(home, { recursive: true, force: true });
  });
  const result = await run;
  assert.equal(result.status, 0, result.failure);
}

test('required local and SSH executors preserve native placement and queue compatibility [Q1,Q2]', { timeout: 20000 }, async t => {
  await privateAdmission(t, `
    const local=await take({requiredExecutor:{kind:'local'},runnersFirstProvider:()=>true});
    assert.equal(local.runner,undefined,'local restriction beats runner-first preference');
    const b=await take({requiredExecutor:{kind:'ssh',host:'fixture-b'}});
    assert.equal(b.runner.host,'fixture-b','other free hosts cannot substitute');
    let observed;
    const waiting=new Promise(resolve=>{observed=resolve;});
    const pending=take({requiredExecutor:{kind:'ssh',host:'fixture-b'},shortEligible:true,shortCapacityProvider:()=>1,
      onWait:state=>{if(!state.admitted){assert.deepEqual(state.line.find(row=>row.requiredExecutor)?.requiredExecutor,{kind:'ssh',host:'fixture-b'});observed();}}});
    await waiting;
    const a=await take({requiredExecutor:{kind:'ssh',host:'fixture-a'}});
    assert.equal(a.runner.host,'fixture-a','blocked B waiter does not block compatible A');
    const short=await take({requiredExecutor:{kind:'local'},shortEligible:true,shortCapacityProvider:()=>1});
    assert.equal(short.slotClass,'short','local short capacity remains usable');
    b.release();
    assert.equal((await pending).runner.host,'fixture-b','SSH waiter never takes the free short slot');
  `);
});

test('executor affinity never relaxes GUI, memory, registration or remote policy [Q1,Q2,E27]', { timeout: 20000 }, async t => {
  await privateAdmission(t, `
    const stop={code:'fixture-wait'};
    await assert.rejects(take({requiredExecutor:{kind:'ssh',host:'fixture-b'},gui:true,
      onWait:state=>{if(!state.admitted)throw stop;}}),error=>error===stop);
    await assert.rejects(take({requiredExecutor:{kind:'local'},memory:async()=>({checked:true,held:true,line:'private hold'}),
      onWait:state=>{if(!state.admitted)throw stop;}}),error=>error===stop);
    const remote=await take({requiredExecutor:{kind:'ssh',host:'fixture-a'},memory:async()=>({checked:true,held:true,line:'private hold'})});
    assert.equal(remote.runner.host,'fixture-a','local memory pressure still allows an eligible remote');
    await assert.rejects(take({requiredExecutor:{kind:'ssh',host:'absent'}}),{code:'BAD_RUNNER_POOL'});
    await assert.rejects(take({requiredExecutor:{kind:'ssh',host:'fixture-b'},remote:false}),{code:'BAD_RESOURCE_METADATA'});
    await assert.rejects(take({requiredExecutor:{kind:'local'},runnerOnly:true}),{code:'BAD_RESOURCE_METADATA'});
  `);
});

test('a constrained landing refuses SSH affinity before invoking its action [E27,E28,Q1]', { timeout: 30000 }, async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node --test');
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.landing = { ...config.landing, manualOverride: true, environment: { platform: process.platform, arch: process.arch, node: process.versions.node } };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'test: constrain private landing');
  const joined = box.run(box.repo, 'settings', 'landing.pool', 'on', '--json');
  assert.equal(joined.code, 0, joined.err);
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {withLandingGateSlot} from ${JSON.stringify(GATE)};
${executionServicesSource(GATE)}
    let called=false;
    await assert.rejects(withLandingGateSlot(process.cwd(),()=>{called=true;},{ executionServices,requiredExecutor:{kind:'ssh',host:'fixture-a'}}),{code:'LAND_ENVIRONMENT'});
    assert.equal(called,false);
  `], { cwd: box.repo, env: box.env });
  assert.equal(result.status, 0, result.failure);
});


test('matching-runner allowlists prefer a free original and retain registration and capability guards [Q1,Q2,E27]', { timeout: 20000 }, async t => {
  await privateAdmission(t, `
    const requiredExecutor={kind:'ssh',host:'fixture-a',hosts:['fixture-a','fixture-b']};
    const a=await take({requiredExecutor});
    assert.equal(a.runner.host,'fixture-a','free original wins');
    const b=await take({requiredExecutor});
    assert.equal(b.runner.host,'fixture-b','busy original does not strand an eligible peer');
    const stop={code:'fixture-wait'};
    await assert.rejects(take({requiredExecutor,shortEligible:true,shortCapacityProvider:()=>1,
      onWait:state=>{if(!state.admitted){assert.deepEqual(state.line.find(row=>row.requiredExecutor)?.requiredExecutor,requiredExecutor);throw stop;}}}),error=>error===stop);
    b.release();
    await assert.rejects(take({requiredExecutor,browser:true,
      onWait:state=>{if(!state.admitted)throw stop;}}),error=>error===stop,'peer without browser never substitutes for a browser check');
    a.release();
    const missingPreferred={kind:'ssh',host:'removed',hosts:['removed','fixture-b']};
    assert.equal((await take({requiredExecutor:missingPreferred})).runner.host,'fixture-b','registry loss narrows the list rather than abandoning an eligible member');
    await assert.rejects(take({requiredExecutor:{kind:'ssh',host:'removed',hosts:['removed']}}),{code:'BAD_RUNNER_POOL'});
    for(const hosts of [[],['fixture-a','fixture-a'],['fixture-b'],['fixture-a',' bad'],Array(2),Array.from({length:65},(_,i)=>'host-'+i)]) {
      await assert.rejects(take({requiredExecutor:{kind:'ssh',host:'fixture-a',hosts}}),{code:'BAD_RESOURCE_METADATA'});
    }
  `);
});
