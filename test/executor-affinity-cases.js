/** @pullboard-test-loads src/resources.js */
/** @pullboard-test-loads src/gate.js */
/** Private native admission restricts placement without granting capacity or capabilities [Q1,Q2,E27]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runFixtureChildAsync } from './fixture-child.js';
import { createE2eHelpers } from './e2e-helpers.js';
const RESOURCES = pathToFileURL(resolve(import.meta.dirname, '../src/resources.js')).href;
const GATE = pathToFileURL(resolve(import.meta.dirname, '../src/gate.js')).href;

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
  config.landing = { environment: { platform: process.platform, arch: process.arch, node: process.versions.node } };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'test: constrain private landing [E27]');
  const joined = box.run(box.repo, 'settings', 'landing.pool', 'on', '--json');
  assert.equal(joined.code, 0, joined.err);
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {withLandingGateSlot} from ${JSON.stringify(GATE)};
    let called=false;
    await assert.rejects(withLandingGateSlot(process.cwd(),()=>{called=true;},{requiredExecutor:{kind:'ssh',host:'fixture-a'}}),{code:'LAND_ENVIRONMENT'});
    assert.equal(called,false);
  `], { cwd: box.repo, env: box.env });
  assert.equal(result.status, 0, result.failure);
});
