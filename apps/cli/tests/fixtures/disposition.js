/** @pullboard-test-loads packages/resources/index.js */
/** Native disposal survives heartbeat discovery without granting foreign or repeat settlement [C7,P3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from './e2e.js';
import { runFixtureChild } from './child.js';

/** Register exact native pruning and settlement cases in the item's combined check. */
export function registerControllerDispositionTests() {
  for (const scenario of ['source cancellation', 'dead controller redispatch']) {
    test(`native orphan disposition permits only its exact ${scenario} once [C7,P3]`, t => {
      const helpers = createE2eHelpers();
      t.after(helpers.cleanup);
      const box = helpers.project('true');
      box.git(box.repo, 'worktree', 'add', '-q', '--detach', join(box.repo, 'source'), 'main');
      const resource = pathToFileURL(join(import.meta.dirname, '../../../../packages/resources/index.js')).href;
      const disposition = pathToFileURL(join(import.meta.dirname, '../../../../packages/resources/src/io/controller/disposition.js')).href;
      const custodian = `import {controllerDeadline} from ${JSON.stringify(resource)};
let input='',custody;process.stdin.on('data',part=>{input+=part;const end=input.indexOf('\\n');if(end<0||custody)return;
const data=JSON.parse(input.slice(0,end));custody=controllerDeadline(data.owner,data.parent,data.root);process.stdout.write('ready\\n');});
process.stdin.on('end',()=>custody?.close());`;
      const script = `import assert from 'node:assert/strict';
import{spawn}from'node:child_process';import{once}from'node:events';
import{rmSync}from'node:fs';import{join}from'node:path';import{DatabaseSync}from'node:sqlite';
import{takeResource,listResources,runnerResourceStatus}from ${JSON.stringify(resource)};
import{consumeControllerDisposition}from ${JSON.stringify(disposition)};
const root=process.cwd(),source=join(root,'source'),scenario=${JSON.stringify(scenario)};
const first={host:'first-disposition.invalid',slots:1,browser:1};
const runners=[first];let lease=await takeResource({name:'gate',capacity:0,scope:'machine',root,repo:source,
agent:'coordinator',item:'2055',kind:'submit',remote:true,runnerOnly:true,runnerWaitMs:5000,runnerProvider:()=>runners});
const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(custodian)}],{env:process.env,stdio:['pipe','pipe','pipe']});
const closed=once(child,'close');let timer;
try{
const ready=Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('custody readiness hang ceiling')),5000);})]); // budget: custody readiness hang ceiling leaves fifteen seconds for owned-child cleanup.
child.stderr.resume();child.stdin.write(JSON.stringify({owner:{token:lease.token,pool:lease.pool},parent:process.pid,root:source})+'\\n');
await ready;clearTimeout(timer);
const db=new DatabaseSync(lease.pool);try{
const owner=db.prepare('SELECT token,pid,started,repo,runner AS host FROM holder WHERE token=?').get(lease.token);
if(scenario==='source cancellation')rmSync(source,{recursive:true});else{child.kill('SIGKILL');await closed;}
listResources();
assert.throws(()=>lease.renew(),{code:'RESOURCE_LEASE_LOST'},'heartbeat/renew already learned native holder was pruned');
const requeued=scenario!=='source cancellation',recorded=requeued?'orphan-requeued':'cleanup';
const cleanup=db.prepare("SELECT id,detail FROM runner_recovery_event WHERE kind=?").get(recorded);
assert.ok(cleanup);const unavailable=requeued?undefined:db.prepare('SELECT since FROM runner_unavailable WHERE host=?').get(first.host).since;
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runner_unavailable WHERE host=?').get(first.host).n,requeued?0:1,requeued?'a dead controller leaves its healthy host in service':'source loss quarantines its runner');
assert.throws(()=>consumeControllerDisposition(db,{...owner,token:'foreign'},'cancel',{version:1,root:source}),{code:'RESOURCE_LEASE_LOST'});
assert.throws(()=>consumeControllerDisposition(db,{...owner,started:owner.started+' foreign'},'requeue'),{code:'RESOURCE_LEASE_LOST'});
const cancellation={version:1,root:source,reason:'source directory is gone',diagnostic:{reason:'source-cancelled',phase:'controller'}};
if(scenario==='source cancellation'){
assert.throws(()=>consumeControllerDisposition(db,owner,'requeue'),{code:'RESOURCE_LEASE_LOST'},'source loss is terminal, never automatic requeue');
assert.throws(()=>consumeControllerDisposition(db,owner,'cancel',{...cancellation,root:root+'-foreign'}),{code:'RESOURCE_LEASE_LOST'});
lease.cancelRunner(cancellation);
assert.equal(db.prepare('SELECT since FROM runner_unavailable WHERE host=?').get(first.host).since,unavailable,'settlement must not duplicate/reset quarantine');
}else{
assert.throws(()=>consumeControllerDisposition(db,owner,'cancel',cancellation),{code:'RESOURCE_LEASE_LOST'},'dead-controller disposal does not impersonate source cancellation');
lease=await lease.requeueRunner('transport-lost');assert.equal(lease.runner.host,first.host,'the healthy host stays in service and takes the redispatch');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runner_unavailable WHERE host=?').get(first.host).n,0,'the requeue leaves the first host in service');
}
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runner_recovery_event WHERE kind=?").get(recorded).n,1);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runner_recovery_event WHERE kind='lease-disposition'").get().n,1);
assert.throws(()=>consumeControllerDisposition(db,owner,scenario==='source cancellation'?'cancel':'requeue',cancellation),{code:'RESOURCE_LEASE_LOST'},'native disposal is consumed once');
const status=runnerResourceStatus(runners).find(row=>row.host===first.host);
if(requeued)assert.equal(status.unavailable,false);else assert.equal(status.unavailableReason,'CLEANUP_UNVERIFIED');
console.log(JSON.stringify({scenario,settled:true}));
}finally{db.close();}
}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;lease.release();}`;
      const env = { ...box.env };
      delete env.NODE_TEST_CONTEXT;
      const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script],
        { cwd: box.repo, env, encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).settled, true);
    });
  }
}
