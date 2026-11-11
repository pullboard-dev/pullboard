/** @pullboard-test-input source-tree */
import { assertMainAuditOpenRouteReplay } from './receipt.js';
import { assertMainAuditReceiptReplay } from './receipt.js';
import { exportBoard } from '../../../../../../packages/store/index.js';
import { importBoard } from '../../../../../../packages/store/index.js';
/** Actual production main audit completes every failure and routes exact file obligations [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startFixtureChild as spawn } from '../../child.js';
import { runFixtureChild as spawnSync } from '../../child.js';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { cpSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const SOURCE=new URL('../../../../../../',import.meta.url);
/** Genuine Git operations retain exact commit identities; no board history is edited directly. */
function git(root,env,...args) {const ran=spawnSync('git',args,{cwd:root,env,encoding:'utf8'});assert.equal(ran.status,0,ran.stderr);return ran.stdout.trim();}
import { mainAuditFixture } from './project.js';

test('production main audit waits for real FF, collects both failures, routes both, and never repeats completion [C7,V4,H16]',{timeout:120_000},async t=>{
  const box=await mainAuditFixture(t);
  await box.runWorker();
  assert.equal(existsSync(join(box.directory,box.key+'.json')),false,'native finish before actual FF is not audit execution');
  assert.equal(existsSync(box.marker),false);
  git(box.repo,box.env,'merge','--ff-only',box.tip);
  await box.runWorker();
  const job=JSON.parse(readFileSync(join(box.directory,box.key+'.json'),'utf8'));
  assert.equal(job.state,'complete',JSON.stringify(job));
  const receipt=box.readGateReceipt(box.receiptStore(box.repo),job.receiptId);
  assert.equal(receipt.head,box.tip);assert.equal(receipt.tree,box.tree);assert.equal(receipt.green,false);assert.equal(receipt.kind,'land');
  assert.equal(receipt.collection.complete,true);assert.equal(receipt.collection.full,true);
  assert.deepEqual(receipt.collection.files,['test/a.test.js','test/b.test.js','test/c.test.js']);assert.equal(receipt.collection.batchId,box.batchId);
  assert.ok(receipt.collection.plannedFiles>0);assert.equal(receipt.collection.plannedFiles,receipt.collection.completedFiles);
  assert.equal(receipt.collection.planDigest,receipt.collection.completedDigest);
  box.board(origin=>{
    const replica=box.store.openBoard(':memory:');
    try {importBoard(replica,exportBoard(origin));assertMainAuditReceiptReplay(origin,replica,
      {agentId:'coordinator',receipt,lane:'alpha'},new Date().toISOString());}
    finally {box.store.closeBoard(replica);}
  });
  for(const [file,name]of[['test/a.test.js','audit failure alpha'],['test/b.test.js','audit failure beta']])assert.ok(receipt.failures.some(row=>row.file===file&&row.name===name),JSON.stringify(receipt.failures));
  assert.equal(readFileSync(box.marker,'utf8'),'ran','green body really executed despite both reds');
  const defects=box.board(db=>box.store.events(db).filter(row=>row.event_kind==='landing-test-defect').map(row=>JSON.parse(row.event_detail).defect));
  assert.equal(defects.length,2,JSON.stringify(defects));
  for(const [file,name,lane]of[['test/a.test.js','audit failure alpha','alpha'],['test/b.test.js','audit failure beta','beta']]){
    const defect=defects.find(row=>row.test===file);assert.ok(defect);assert.ok(defect.names.includes(name));assert.equal(defect.batchId,box.batchId);
    assert.equal(box.board(db=>box.store.getItem(db,defect.item).item_lane),lane);
  }
  assert.equal(readdirSync(box.directory).some(name=>name.startsWith('source-')),false,'owned audit worktree removed normally');
  assert.equal(git(box.repo,box.env,'worktree','list','--porcelain').split('\n').filter(line=>line.startsWith('worktree ')).length,1);
  const receipts=readdirSync(box.receiptStore(box.repo)).sort(),beforeEvents=box.board(db=>box.store.events(db));
  await box.runWorker();
  assert.deepEqual(readdirSync(box.receiptStore(box.repo)).sort(),receipts,'completed job does not run gate again');
  assert.deepEqual(box.board(db=>box.store.events(db)),beforeEvents,'repeat creates no duplicate routes or gate event');
  // A later genuinely landed batch keeps the failing a/b blobs unchanged. Its old routes are closed.
  const closedItems=box.board(db=>{
    for(const defect of defects)box.store.withdraw(db,defect.item,{agentId:'coordinator',reason:'private recurrence control: original repair withdrawn'});
    return defects.map(defect=>box.store.getItem(db,defect.item));
  });
  const secondBatch=box.appendBatch();
  for(const defect of defects)assert.equal(git(box.repo,box.env,'rev-parse',`${secondBatch.tip}:${defect.test}`),defect.blob,'recurrence uses exact same failing blob');
  box.board(origin=>{
    const replica=box.store.openBoard(':memory:');
    try {
      importBoard(replica,exportBoard(origin));
      const first=defects[0];
      assertMainAuditOpenRouteReplay(origin,replica,{agentId:'coordinator',test:first.test,hash:first.hash,
        blob:first.blob,trunkBlob:first.blob,names:[...first.names],lane:closedItems[0].item_lane,
        batchId:secondBatch.batchId,branch:first.branch,requireOpen:true},first.item,new Date().toISOString());
    }finally{box.store.closeBoard(replica);}
  });
  await box.runWorker();
  const secondJob=JSON.parse(readFileSync(join(box.directory,secondBatch.key+'.json'),'utf8'));
  assert.equal(secondJob.state,'complete',JSON.stringify(secondJob));
  const secondReceipt=box.readGateReceipt(box.receiptStore(box.repo),secondJob.receiptId);
  assert.equal(secondReceipt.head,secondBatch.tip);assert.equal(secondReceipt.tree,secondBatch.tree);
  assert.equal(secondReceipt.collection.batchId,secondBatch.batchId);assert.equal(secondReceipt.collection.complete,true);
  assert.equal(secondReceipt.collection.full,true);assert.equal(secondReceipt.green,false);
  assert.equal(readFileSync(secondBatch.marker,'utf8'),'ran','second actual gate ran its green body despite same-blob reds');
  const secondDefects=box.board(db=>box.store.events(db).filter(row=>row.event_kind==='landing-test-defect')
    .map(row=>JSON.parse(row.event_detail).defect).filter(defect=>defect.batchId===secondBatch.batchId));
  assert.equal(secondDefects.length,2);
  for(const old of defects){
    const next=secondDefects.find(defect=>defect.test===old.test);assert.ok(next);
    assert.notEqual(next.item,old.item,'closed same-blob repair is never reused');
    assert.equal(next.hash,old.hash);assert.equal(next.blob,old.blob);assert.equal(next.branch,old.branch);
    assert.deepEqual(next.names,old.names,'all exact failing names are retained');
    assert.equal(box.board(db=>box.store.getItem(db,next.item).item_status),'open');
    assert.deepEqual(box.board(db=>box.store.getItem(db,old.item)),closedItems.find(item=>item.item_id===old.item),'old withdrawn repair unchanged');
  }
  const repeatedReceipts=readdirSync(box.receiptStore(box.repo)).sort(),repeatedEvents=box.board(db=>box.store.events(db));
  await box.runWorker();
  assert.deepEqual(readdirSync(box.receiptStore(box.repo)).sort(),repeatedReceipts,'both completed batches retain their actual receipts without another gate');
  assert.deepEqual(box.board(db=>box.store.events(db)),repeatedEvents,'no duplicate open routes or native gate events');
});

/** Wait on observable ownership/admission state, never use a sleep to assert absence of work. */
async function observed(read,name){const deadline=Date.now()+30_000;while(Date.now()<deadline){const value=read();if(value)return value;await pause(20);}assert.fail(`missing ${name}`);}

test('a contender wake makes the original main audit owner drain a later real landing without a third nudge [C7,V4,H16]',{timeout:150_000},async t=>{
  const box=await mainAuditFixture(t);const release=await box.holdBoth();
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
