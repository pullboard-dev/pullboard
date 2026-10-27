/** @pullboard-test-input src/** bin/** package.json */
/** @pullboard-module-loads src/board.js src/main-audit-state.js src/gate-run-receipt.js */
import { assertMainAuditOpenRouteReplay } from './main-audit-receipt-fixture.js';
import { assertMainAuditReceiptReplay } from './main-audit-receipt-fixture.js';
import { exportBoard, importBoard } from '../src/exchange.js';
/** Actual production main audit completes every failure and routes exact file obligations [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startFixtureChild as spawn, runFixtureChild as spawnSync } from './fixture-child.js';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const SOURCE=new URL('../',import.meta.url);
/** Genuine Git operations retain exact commit identities; no board history is edited directly. */
function git(root,env,...args) {const ran=spawnSync('git',args,{cwd:root,env,encoding:'utf8'});assert.equal(ran.status,0,ran.stderr);return ran.stdout.trim();}
/** Copy actual installed source with spaces and a separate real tracked main project. */
async function mainAuditFixture(t) {
  const scratch=mkdtempSync(join(tmpdir(),'pullboard main audit ')),installed=join(scratch,'installed tooling'),repo=join(scratch,'repo'),machine=join(scratch,'machine');
  mkdirSync(installed);mkdirSync(repo);mkdirSync(machine);
  for(const folder of [installed,repo])for(const name of ['src','bin','package.json'])cpSync(new URL(name,SOURCE),join(folder,name),{recursive:true});
  assert.equal(existsSync(join(installed,'.git')),false);
  const env={...process.env,HOME:join(scratch,'home'),PULLBOARD_HOME:join(scratch,'pullboard'),PULLBOARD_MACHINE_HOME:machine,
    GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
  for(const name of Object.keys(env))if(name.startsWith('GIT_')&&!/^(?:GIT_CONFIG_|GIT_AUTHOR_|GIT_COMMITTER_)/u.test(name))delete env[name];
  for(const name of ['PULLBOARD_GATE_SLOT_HELD','PULLBOARD_GATE_SLOT_POOL','PULLBOARD_GATE_SLOT_TOKEN','PULLBOARD_BROWSER_SLOT_HELD','PULLBOARD_CHECKOUT_SESSION_TOKEN'])delete env[name];
  writeFileSync(join(machine,'settings.json'),JSON.stringify({gateSlots:2,browserSlots:2,gate:{browserFreeChecks:true}}));
  writeFileSync(join(repo,'pullboard.json'),JSON.stringify({gate:'node bin/run-tests.js',landingShards:2,verify:'any',lanes:{alpha:{owns:['test/a.test.js'],specs:[]},beta:{owns:['test/b.test.js','test/c.test.js'],specs:[]}},shared:['src/','bin/','package.json','pullboard.json']}));
  mkdirSync(join(repo,'test'));for(const name of ['a','b','c'])writeFileSync(join(repo,'test',name+'.test.js'),`import {test} from 'node:test';test('base ${name}',()=>{});\n`);
  git(repo,env,'init','-q','-b','main');git(repo,env,'add','-A');git(repo,env,'commit','-q','-m','chore: base audit fixture');const base=git(repo,env,'rev-parse','HEAD');
  const store=await import(pathToFileURL(join(installed,'src/board.js')));
  const {activateMainAudits,mainAuditKey}=await import(pathToFileURL(join(installed,'src/main-audit-state.js')));
  const {readGateReceipt,receiptStore}=await import(pathToFileURL(join(installed,'src/gate-run-receipt.js')));
  const boardFile=join(repo,'.git/pullboard/board.sqlite');
  /** Close board ownership before any process execution or native admission. */
  function board(action){const db=store.openBoard(boardFile,undefined,{isMain:true});try{return action(db);}finally{store.closeBoard(db);}}
  const actors=board(db=>{db.executionEngineVersion=1;try{return[store.register(db,{lane:'coordinator',path:repo}),store.register(db,{lane:'alpha',path:join(scratch,'builder')}),store.register(db,{lane:'beta',path:join(scratch,'reviewer')})];}finally{delete db.executionEngineVersion;}});
  const identity=board(db=>({id:store.boardId(db),after:store.events(db).at(-1).event_id}));await activateMainAudits(repo,identity.after,identity.id);
  const candidate=join(scratch,'candidate');git(repo,env,'worktree','add','--detach',candidate,base);
  const marker=join(scratch,'green-body-ran');
  writeFileSync(join(candidate,'test/a.test.js'),"import {test} from 'node:test';test('audit failure alpha',()=>{throw new Error('actual alpha');});\n");
  writeFileSync(join(candidate,'test/b.test.js'),"import {test} from 'node:test';test('audit failure beta',()=>{throw new Error('actual beta');});\n");
  writeFileSync(join(candidate,'test/c.test.js'),`import {test} from 'node:test';import {appendFileSync} from 'node:fs';test('later green body',()=>appendFileSync(${JSON.stringify(marker)},'ran'));\n`);
  git(candidate,env,'add','test');git(candidate,env,'commit','-q','-m','test: actual combined failing tree');const tip=git(candidate,env,'rev-parse','HEAD'),tree=git(candidate,env,'rev-parse','HEAD^{tree}');git(repo,env,'worktree','remove',candidate);
  const batchId=randomUUID();
  // Synthetic PRE-AUDIT acceptance models existing native landing protocol only. It is not a gate proof.
  const item=board(db=>{
    const id=store.addItem(db,{by:'coordinator',lane:'alpha',title:'Accepted batch fixture',criterion:'Pre-audit protocol input'});
    store.claim(db,id,{agentId:actors[1],lane:'alpha',leaseMs:3600000,freeze:()=>({text:JSON.stringify({policy:{version:1,commit:base,verify:{policy:'any',family:'off'}}}),digest:'fixture-accepted-bar'})});
    store.submit(db,id,{agentId:actors[1],commit:tip,tree,submissionProof:{version:1,files:[],full:false,deferred:true,reason:'synthetic pre-audit acceptance; no runtime evidence'}});
    store.verify(db,id,{agentId:actors[2],head:tip,digest:'fixture-accepted-bar',policy:'any',decision:'ACCEPT',note:'synthetic pre-audit acceptance only'});
    const entry={id,commit:tip,merge:tip};
    store.recordLandingBatch(db,{agentId:'coordinator',batch:{version:1,id:batchId,state:'trunk',base,tip,root:repo,branch:'refs/heads/main',owner:'coordinator-fixture',logPath:join(scratch,'pre-audit.log'),items:[entry]}});
    store.finishLandingBatch(db,{agentId:'coordinator',id:batchId,tip});return id;
  });
  const directory=join(repo,'.git/pullboard/main-audits'),key=mainAuditKey({board:identity.id,batchId,tip,tree});
  const children=[];
  /** Invoke the real copied worker; no fake gate, mocked transport, or injected receipt is used. */
  function startWorker() {
    const token=randomUUID();
    const child=spawn(process.execPath,[join(installed,'bin/main-audit.js'),repo,token],{cwd:repo,env,detached:true,stdio:['ignore','pipe','pipe'],timeout:60_000});
    children.push(child);child.stdout.resume();let err='';child.stderr.on('data',b=>{err+=b;});const closed=once(child,'close');
    return {child,token,closed,async finish(){const[code,signal]=await closed;assert.equal(signal,null,err);assert.equal(code,0,err);}};
  }
  /** Existing tests retain a successful terminal worker helper. */
  async function runWorker(){await startWorker().finish();}
  /** Observe queue reservations read-only, without lease or stale-row mutation. */
  function queue(){const db=new DatabaseSync(join(machine,'resources.sqlite'),{readOnly:true});try{return db.prepare('SELECT * FROM waiter').all();}finally{db.close();}}
  /** Hold both private production gate slots, releasing only this owned child's actions by IPC. */
  async function holdBoth(){
    const module=pathToFileURL(join(installed,'src/gate.js')).href;
    const code=`import {withGateSlot} from ${JSON.stringify(module)};await Promise.all([0,1].map(i=>withGateSlot(${JSON.stringify(repo)},async()=>{process.send({held:i});await new Promise(r=>process.once('message',r));},{remote:false,browser:false,agent:'fixture-slot-'+i})));process.disconnect();`;
    const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:repo,env,detached:true,stdio:['ignore','pipe','pipe','ipc']});children.push(child);child.stdout.resume();child.stderr.resume();const closed=once(child,'close');const held=new Set();child.on('message',m=>held.add(m.held));
    await observed(()=>held.size===2,'both production gate slots held');
    return async()=>{child.send('release');assert.equal((await closed)[0],0);};
  }
  /** Create B through genuine Git and native protocol; acceptance is synthetic PRE-AUDIT setup only. */
  function appendBatch(){
    const from=git(repo,env,'rev-parse','HEAD'),nextCandidate=join(scratch,'candidate-B'),nextMarker=join(scratch,'green-body-B');
    git(repo,env,'worktree','add','--detach',nextCandidate,from);
    writeFileSync(join(nextCandidate,'test/c.test.js'),`import {test} from 'node:test';import {appendFileSync} from 'node:fs';test('later green body B',()=>appendFileSync(${JSON.stringify(nextMarker)},'ran'));\n`);
    git(nextCandidate,env,'add','test/c.test.js');git(nextCandidate,env,'commit','-q','-m','test: second genuinely landed audit tree');
    const nextTip=git(nextCandidate,env,'rev-parse','HEAD'),nextTree=git(nextCandidate,env,'rev-parse','HEAD^{tree}');git(repo,env,'worktree','remove',nextCandidate);
    const nextBatch=randomUUID();
    const nextItem=board(db=>{
      const id=store.addItem(db,{by:'coordinator',lane:'alpha',title:'B pre-audit protocol',criterion:'Synthetic acceptance input only'});
      store.claim(db,id,{agentId:actors[1],lane:'alpha',leaseMs:3600000,freeze:()=>({text:JSON.stringify({policy:{version:1,commit:from,verify:{policy:'any',family:'off'}}}),digest:'fixture-B-bar'})});
      store.submit(db,id,{agentId:actors[1],commit:nextTip,tree:nextTree,submissionProof:{version:1,files:[],full:false,deferred:true,reason:'synthetic pre-audit acceptance; no runtime evidence'}});
      store.verify(db,id,{agentId:actors[2],head:nextTip,digest:'fixture-B-bar',policy:'any',decision:'ACCEPT',note:'synthetic B pre-audit protocol only'});
      const entry={id,commit:nextTip,merge:nextTip};store.recordLandingBatch(db,{agentId:'coordinator',batch:{version:1,id:nextBatch,state:'trunk',base:from,tip:nextTip,root:repo,branch:'refs/heads/main',owner:'coordinator-fixture',logPath:join(scratch,'B-pre-audit.log'),items:[entry]}});
      store.finishLandingBatch(db,{agentId:'coordinator',id:nextBatch,tip:nextTip});return id;
    });
    git(repo,env,'merge','--ff-only',nextTip);
    return {tip:nextTip,tree:nextTree,batchId:nextBatch,item:nextItem,marker:nextMarker,key:mainAuditKey({board:identity.id,batchId:nextBatch,tip:nextTip,tree:nextTree})};
  }
  t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}}await Promise.all(children.map(child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():once(child,'close')));rmSync(scratch,{recursive:true,force:true});});
  return {repo,env,base,tip,tree,batchId,item,marker,directory,key,board,store,runWorker,startWorker,holdBoth,appendBatch,queue,readGateReceipt,receiptStore};
}

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
