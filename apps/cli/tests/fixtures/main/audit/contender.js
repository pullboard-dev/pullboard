/** @pullboard-test-input source-tree */
/** The contender-wake main audit case runs in its own file, so each audit file stays under two minutes [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../child.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { mainAuditFixture } from './project.js';
import { observed } from './project.js';

/** Genuine Git operations retain exact commit identities; no board history is edited directly. */
function git(root,env,...args) {const ran=spawnSync('git',args,{cwd:root,env,encoding:'utf8'});assert.equal(ran.status,0,ran.stderr);return ran.stdout.trim();}

test('a contender wake makes the original main audit owner drain a later real landing without a third nudge [C7,V4,H16]',{timeout:150_000},async t=>{
  const box=await mainAuditFixture(t,{landingShards:1});const release=await box.holdBoth();
  git(box.repo,box.env,'merge','--ff-only',box.tip);
  const first=box.startWorker();
  const ownerFile=join(box.directory,'owner.json'),wakeFile=join(box.directory,'wake.json');
  await observed(()=>existsSync(ownerFile)&&JSON.parse(readFileSync(ownerFile,'utf8')).pid===first.child.pid,'owner A');
  await observed(()=>existsSync(join(box.directory,box.key+'.json'))&&JSON.parse(readFileSync(join(box.directory,box.key+'.json'),'utf8')).state==='running'&&box.queue().some(row=>row.pid===first.child.pid),'A real gate wait');
  const beforeOwner=JSON.parse(readFileSync(ownerFile,'utf8')),beforeWake=JSON.parse(readFileSync(wakeFile,'utf8')).generation;
  const secondBatch=box.appendBatch();const contender=box.startWorker();await contender.finish();
  assert.deepEqual(JSON.parse(readFileSync(ownerFile,'utf8')),beforeOwner,'B contender never replaces live A');
  assert.ok(JSON.parse(readFileSync(wakeFile,'utf8')).generation>beforeWake,'B leaves a durable wake before exiting');
  await release();await first.finish(); // No third nudge/worker invocation.
  const jobs=[box,secondBatch].map(batch=>({batch,job:JSON.parse(readFileSync(join(box.directory,batch.key+'.json'),'utf8'))}));
  for(const {batch,job}of jobs){
    assert.equal(job.state,'complete',JSON.stringify(job));
    const receipt=box.readGateReceipt(box.receiptStore(box.repo),job.receiptId);
    assert.equal(receipt.head,batch.tip);assert.equal(receipt.tree,batch.tree);assert.equal(receipt.collection.batchId,batch.batchId);
    assert.equal(receipt.collection.complete,true);assert.equal(receipt.collection.full,true);assert.equal(receipt.green,false);
    assert.ok(receipt.failures.some(row=>row.file==='test/a.test.js'&&row.name==='audit failure alpha'));
    assert.ok(receipt.failures.some(row=>row.file==='test/b.test.js'&&row.name==='audit failure beta'));
    assert.equal(readFileSync(batch.marker,'utf8'),'ran','each distinct landed green body ran exactly once');
  }
  const events=box.board(db=>box.store.events(db));
  for(const {batch,job}of jobs){
    assert.equal(events.filter(row=>row.event_kind==='gate-run'&&JSON.parse(row.event_detail).run?.id===job.receiptId).length,1,'one native gate receipt event per batch');
    const routed=events.filter(row=>row.event_kind==='landing-test-defect').map(row=>JSON.parse(row.event_detail).defect).filter(row=>row.batchId===batch.batchId);
    assert.deepEqual(routed.map(row=>row.test).sort(),['test/a.test.js','test/b.test.js'],'exactly two file routes per batch');
  }
  assert.equal(existsSync(ownerFile),false);assert.equal(box.queue().length,0);
  assert.equal(readdirSync(box.directory).some(name=>name.startsWith('source-')),false);
  assert.equal(git(box.repo,box.env,'worktree','list','--porcelain').split('\n').filter(line=>line.startsWith('worktree ')).length,1);
});
