/** @pullboard-module-loads apps/lib/index.js packages/gate/src/io/main/audit/state.js packages/gate/src/io/run/receipt.js */
/** Shared real main-audit fixture; synthetic acceptance is setup, never runtime proof [C7]. */
/** @pullboard-test-input apps/cli/pullboard.js apps/cli/src/io/landing/audit.js apps/lib/index.js packages/gate/index.js packages/gate/src/io/browser/guard.js packages/gate/tests/fixtures/budgets.js */
import { executionServicesSource } from '../../gate/execution.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  startFixtureChild as spawn,
  runFixtureChild as spawnSync,
} from '../../child.js';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  copyPackageFiles,
  packageFiles,
} from '../../../../../../packages/runners/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';
import { repoPath } from '../../../../../../packages/kernel/light.js';
import {
  mainAuditKey,
  readMainAudit,
} from '../../../../../../packages/gate/index.js';
/** Read only the exact native audit identity; malformed or mismatched journals fail the owning fixture. */
export function readAuditJob(directory, key) {
  assert.match(key, /^[a-f0-9]{64}$/u, 'audit journal identity is the exact native digest');
  const job = readMainAudit(join(directory, `${key}.json`));
  assert.ok(job, 'the actual native audit journal exists');
  assert.equal(job.version, 1, 'the native journal schema is explicit');
  assert.equal(mainAuditKey(job), key, 'the journal binds the requested board, batch and source identity');
  return job;
}
const SOURCE=new URL('../../../../../../',import.meta.url);
/** Run actual Git in the private fixture and retain failures. */
function git(root,env,...args){const ran=spawnSync('git',args,{cwd:root,env,encoding:'utf8'});assert.equal(ran.status,0,ran.stderr);return ran.stdout.trim();}
/** Wait for an observed native ownership boundary. */
async function observed(read,name){const deadline=Date.now()+30_000;while(Date.now()<deadline){const value=read();if(value)return value;await pause(20);}assert.fail(`missing ${name}`);}
/** Copy actual installed source with spaces and a separate real tracked main project. */
export async function mainAuditFixture(t, { initialGreen = false, requireRealGit = false } = {}) {
  const scratch=mkdtempSync(join(tmpdir(),'pullboard main audit ')),installed=join(scratch,'installed tooling'),repo=join(scratch,'repo'),machine=join(scratch,'machine');
  mkdirSync(installed);mkdirSync(repo);mkdirSync(machine);
  // This full-audit project deliberately has only its three test files; copied documentation tests are not its suite.
  const source=fileURLToPath(SOURCE),files=packageFiles(source).filter(file=>file==='package.json'||file==='packages/gate/tests/fixtures/budgets.js'||/^(?:src|bin|packages|apps)\//u.test(file)&&!/^(?:test\/|packages\/[^/]+\/tests\/|apps\/[^/]+\/(?:tests|journeys)\/)/u.test(file));
  for(const folder of [installed,repo])copyPackageFiles(source,folder,{files});
  assert.equal(existsSync(join(installed,'.git')),false);
  const env={...process.env,HOME:join(scratch,'home'),PULLBOARD_HOME:join(scratch,'pullboard'),PULLBOARD_MACHINE_HOME:machine,
    GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
  // The runner's launch guard names this checkout's copy; the installed worker knows only its own copy, so point the guard there.
  const outerGuard=new URL('../../../../../../packages/gate/src/io/browser/guard.js',import.meta.url).href,installedGuard=pathToFileURL(join(installed,'packages/gate/src/io/browser/guard.js')).href;
  if(env.NODE_OPTIONS)env.NODE_OPTIONS=env.NODE_OPTIONS.replaceAll(`--import=${outerGuard}`,`--import=${installedGuard}`);
  for(const name of Object.keys(env))if(name.startsWith('GIT_')&&!/^(?:GIT_CONFIG_|GIT_AUTHOR_|GIT_COMMITTER_)/u.test(name))delete env[name];
  for(const name of ['PULLBOARD_GATE_SLOT_HELD','PULLBOARD_GATE_SLOT_POOL','PULLBOARD_GATE_SLOT_TOKEN','PULLBOARD_BROWSER_SLOT_HELD','PULLBOARD_CHECKOUT_SESSION_TOKEN'])delete env[name];
  writeFileSync(join(machine,'settings.json'),JSON.stringify({gateSlots:2,browserSlots:2,gate:{browserFreeChecks:true}}));
  writeFileSync(join(repo,'pullboard.json'),JSON.stringify({gate:'node apps/cli/src/io/run/tests.js',landingShards:2,verify:'any',lanes:{alpha:{owns:['test/a.test.js'],specs:[]},beta:{owns:['test/b.test.js','test/c.test.js'],specs:[]}},shared:['src/','bin/','package.json','pullboard.json']}));
  mkdirSync(join(repo,'test'));for(const name of ['a','b','c'])writeFileSync(repoPath(repo, `test/${name}.test.js`),`import {test} from 'node:test';test('base ${name}',()=>{});\n`);
  git(repo,env,'init','-q','-b','main');git(repo,env,'add','-A');git(repo,env,'commit','-q','-m','chore: base audit fixture');const base=git(repo,env,'rev-parse','HEAD');
  const { board: store }=await import(pathToFileURL(join(installed,'apps/lib/index.js')));
  const native = await import(pathToFileURL(join(installed,'apps/lib/index.js')));
  const {activateMainAudits,mainAuditKey}=await import(pathToFileURL(join(installed,'packages/gate/index.js')));
  const {readGateReceipt,receiptStore}=await import(pathToFileURL(join(installed,'packages/gate/index.js')));
  const boardFile=join(repo,'.git/pullboard/board.sqlite');
  /** Close board ownership before any process execution or native admission. */
  function board(action){const db=native.openBoard(boardFile,undefined,{isMain:true,gitRoot:repo});try{return action(db);}finally{store.closeBoard(db);}}
  const actors=board(db=>{db.executionEngineVersion=1;try{return[store.register(db,{lane:'coordinator',path:repo}),store.register(db,{lane:'alpha',path:join(scratch,'builder')}),store.register(db,{lane:'beta',path:join(scratch,'reviewer')})];}finally{delete db.executionEngineVersion;}});
  const identity=board(db=>({id:store.boardId(db),after:store.events(db).at(-1).event_id}));await activateMainAudits(repo,identity.after,identity.id);
  const candidate=join(scratch,'candidate');git(repo,env,'worktree','add','--detach',candidate,base);
  const marker=join(scratch,'green-body-ran');
  const unitMarker=join(scratch,'unchanged-unit-ran');
  /** Preserve the actual unchanged-unit marker bytes without exposing its path as an inferred object capability. */
  function readUnitMarker() {
    return readFileSync(unitMarker, 'utf8');
  }
  writeFileSync(join(candidate,'test/a.test.js'),"import {test} from 'node:test';test('audit failure alpha',()=>{throw new Error('actual alpha');});\n");
  writeFileSync(join(candidate,'test/b.test.js'),"import {test} from 'node:test';test('audit failure beta',()=>{throw new Error('actual beta');});\n");
  writeFileSync(join(candidate,'test/c.test.js'),`import {test} from 'node:test';import {appendFileSync} from 'node:fs';test('later green body',()=>appendFileSync(${JSON.stringify(marker)},'ran'));\n`);
  if (requireRealGit) {
    writeFileSync(join(candidate,'test/c.test.js'), `import {test} from 'node:test';import assert from 'node:assert/strict';import {withGitAdapter,currentGitAdapter,realGitAdapter} from '../packages/git/index.js';import {writeFileSync} from 'node:fs';test('audit uses real Git',()=>{assert.equal(process.env.PULLBOARD_TEST_REAL,'all');const fake={spawnSync(){},execFileSync(){},spawn(){}};withGitAdapter(fake,()=>assert.equal(currentGitAdapter(),realGitAdapter));writeFileSync(${JSON.stringify(marker)},'ran');});\n`);
  }
  if (initialGreen) {
    writeFileSync(join(candidate,'test/a.test.js'),`import {test} from 'node:test';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';test('CLI journey audit',()=>assert.equal(spawnSync(process.execPath,['apps/cli/pullboard.js','--version']).status,0));\n`);
    writeFileSync(join(candidate,'test/b.test.js'),`import {test} from 'node:test';import {appendFileSync} from 'node:fs';test('unchanged paid unit',()=>appendFileSync(${JSON.stringify(unitMarker)},'ran'));\n`);
  }
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
  function startWorker({ scheduled = false } = {}) {
    const token=randomUUID();
    const child=spawn(process.execPath,[join(installed,'apps/cli/src/io/landing/audit.js'),repo,token,...(scheduled?['--scheduled']:[])],{cwd:repo,env,detached:true,stdio:['ignore','pipe','pipe'],timeout:60_000});
    children.push(child);child.stdout.resume();let err='';child.stderr.on('data',b=>{err+=b;});const closed=once(child,'close');
    return {child,token,closed,async finish(){const[code,signal]=await closed;assert.equal(signal,null,err);assert.equal(code,0,err);}};
  }
  /** Existing tests retain a successful terminal worker helper. */
  async function runWorker(){await startWorker().finish();}
  /** Observe actual queue rows while its workers initialize or commit, without retrying an assertion or changing leases. */
  function queue(){
    const db=new DatabaseSync(join(machine,'resources.sqlite'),{readOnly:true});
    try {
      // Match the production queue connection's bounded busy handler: this observer shares its real database.
      db.exec('PRAGMA busy_timeout = 10000');
      return db.prepare('SELECT * FROM waiter').all();
    } finally { db.close(); }
  }
  /** Hold both private production gate slots, releasing only this owned child's actions by IPC. */
  async function holdBoth(){
    const module=pathToFileURL(join(installed,'packages/gate/index.js')).href;
    const code=`import {withGateSlot} from ${JSON.stringify(module)};
${executionServicesSource(module)}await Promise.all([0,1].map(i=>withGateSlot(${JSON.stringify(repo)},async()=>{process.send({held:i});await new Promise(r=>process.once('message',r));},{ executionServices,remote:false,browser:false,agent:'fixture-slot-'+i})));process.disconnect();`;
    const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:repo,env,detached:true,stdio:['ignore','pipe','pipe','ipc']});children.push(child);child.stdout.resume();child.stderr.resume();const closed=once(child,'close');const held=new Set();child.on('message',m=>held.add(m.held));
    await observed(()=>held.size===2,'both production gate slots held');
    return async()=>{child.send('release');assert.equal((await closed)[0],0);};
  }
  /** Create B through genuine Git and native protocol; acceptance is synthetic PRE-AUDIT setup only. */
  function appendBatch({ fail = false } = {}){
    const from=git(repo,env,'rev-parse','HEAD'),nextCandidate=join(scratch,'candidate-B'),nextMarker=join(scratch,'green-body-B');
    git(repo,env,'worktree','add','--detach',nextCandidate,from);
    writeFileSync(join(nextCandidate,'test/c.test.js'),`import {test} from 'node:test';import {appendFileSync} from 'node:fs';test('later green body B',()=>appendFileSync(${JSON.stringify(nextMarker)},'ran'));\n`);
    if (fail) writeFileSync(join(nextCandidate,'test/a.test.js'),"import {test} from 'node:test';test('audit seeded red',()=>{throw new Error('actual audit red')});\n");
    git(nextCandidate,env,'add','test');git(nextCandidate,env,'commit','-q','-m','test: second genuinely landed audit tree');
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
  return {repo,env,base,tip,tree,batchId,item,marker,unitMarker,readUnitMarker,directory,key,board,store,runWorker,startWorker,holdBoth,appendBatch,queue,readGateReceipt,receiptStore};
}

