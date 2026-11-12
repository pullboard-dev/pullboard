/** @pullboard-test-input source-tree */
/** @pullboard-module-loads apps/lib/index.js */
/** Real Git and native historical state are setup; only the production worker supplies rerun evidence [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { runFixtureChild } from '../child.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { copyPackageFiles } from '../../../../../packages/runners/index.js';

const SOURCE = new URL('../../../../../', import.meta.url);

/** Copy actual installed code, create a real tracked project and seed one explicitly synthetic prior acceptance. */
export async function mainMovedFixture(t, { conflict = false, generated = false, red = false, submitted = false, dirty = false, outside = false, selective = false, blocked = false, manualLanding = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(),'pullboard-main-moved-'));
  const installed = join(scratch,'installed'), repo = join(scratch,'repo'), machine = join(scratch,'machine');
  for (const folder of [installed,repo,machine]) mkdirSync(folder);
  copyPackageFiles(fileURLToPath(SOURCE),installed);
  let shipped = [];
  if (!selective) {
    const tooling = join(repo,'.tooling');
    shipped = copyPackageFiles(fileURLToPath(SOURCE),tooling);
    mkdirSync(join(repo,'apps/cli'),{recursive:true});
    writeFileSync(join(repo,'apps/cli/pullboard.js'),`/** @pullboard-module-loads .tooling/apps/cli/pullboard.js */\nimport {spawnSync} from 'node:child_process';\nimport {fileURLToPath} from 'node:url';\nconst entry=fileURLToPath(new URL('../../.tooling/apps/cli/pullboard.js',import.meta.url));\nconst child=spawnSync(process.execPath,[...process.execArgv,entry,...process.argv.slice(2)],{stdio:'inherit'});\nif(child.error)throw child.error;\nif(child.signal)process.kill(process.pid,child.signal);\nelse process.exitCode=child.status??1;\n`);
  }
  writeFileSync(join(repo,'package.json'),JSON.stringify({private:true,type:'module'}));
  const env = { ...process.env, HOME: join(scratch,'home'), PULLBOARD_HOME: join(scratch,'home','pullboard'),
    PULLBOARD_MACHINE_HOME: machine, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1',
    GIT_AUTHOR_NAME:'Fixture', GIT_AUTHOR_EMAIL:'fixture@example.invalid', GIT_COMMITTER_NAME:'Fixture', GIT_COMMITTER_EMAIL:'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !/^(?:GIT_CONFIG_|GIT_AUTHOR_|GIT_COMMITTER_)/u.test(key)) delete env[key];
  for (const key of ['NODE_TEST_CONTEXT','PULLBOARD_GATE_SLOT_HELD','PULLBOARD_GATE_SLOT_POOL','PULLBOARD_GATE_SLOT_TOKEN','PULLBOARD_BROWSER_SLOT_HELD','PULLBOARD_CHECKOUT_SESSION_TOKEN','PULLBOARD_RELAY_TOKEN','SSH_AUTH_SOCK']) delete env[key];
  writeFileSync(join(machine,'settings.json'),JSON.stringify({gateSlots:1,browserSlots:1,gate:{browserFreeChecks:true}}));
  /** Real Git output is retained on failure rather than replaced with fixture results. */
  function git(cwd,...args) {
    const run = runFixtureChild('git',args,{cwd,env,encoding:'utf8'});
    assert.equal(run.status,0,run.context ?? run.stderr); return run.stdout.trim();
  }
  /** Execute ordinary public CLI; no actor override or command-specific fake is provided. */
  function cli(...args) { return runFixtureChild(process.execPath,[join(installed,'apps/cli/pullboard.js'),...args],{cwd:repo,env,encoding:'utf8'}); }
  const marker = join(scratch,'actual-check-bodies');
  const gateEntered = join(scratch, 'advance-gate-entered'), gateRelease = join(scratch, 'advance-gate-release');
  for (const name of ['web','test','docs']) mkdirSync(join(repo,name),{recursive:true});
  writeFileSync(join(repo,'SPEC.md'),'# Private fixture specification\n');
  const check = 'node --test --test-reporter=tap test/check.test.js';
  writeFileSync(join(repo,'pullboard.json'),JSON.stringify({gate:check,...(selective?{affectedTests:'node --test --test-reporter=tap'}:{}),...(manualLanding?{landing:{manualOverride:true}}:{}),submitGate:'landing',submitDeferAbove:1,
    spec:'SPEC.md',verify:'any',lanes:{web:{owns:['web/'],specs:[]},review:{owns:['test/'],specs:[]}},shared:['docs/','src/','bin/','package.json','pullboard.json']}));
  writeFileSync(join(repo,'web/feature.js'),"export const feature = 'base';\n");
  writeFileSync(join(repo,'web/other.js'),"export const other = 'base';\n");
  writeFileSync(join(repo,'test/check.test.js'),`import {test} from 'node:test';import assert from 'node:assert/strict';import {writeFileSync,existsSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {feature} from '../web/feature.js';import {other} from '../web/other.js';test('actual exact composed behavior',()=>{console.log('SOURCE_ADVANCE_BODY');${blocked?`writeFileSync(${JSON.stringify(gateEntered)},'entered');const end=Date.now()+30000;while(!existsSync(${JSON.stringify(gateRelease)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);assert.ok(existsSync(${JSON.stringify(gateRelease)}),'test-owned source gate is released');`:''}assert.equal(feature,'accepted');assert.equal(other,'base');${dirty?"writeFileSync('web/other.js',\"export const other = 'dirty';\\n\");writeFileSync('untracked-after-check.txt','actual child output');execFileSync('git',['init','-q','nested-child-repo']);writeFileSync('nested-child-repo/body.txt','actual nested Git fixture');":''}});\n`);
  if (selective) writeFileSync(join(repo,'test/unrelated.test.js'),`import {test} from 'node:test';test('unrelated project body',()=>console.log('UNRELATED_BODY'));\n`);
  writeFileSync(join(repo,'docs/lifecycle.md'),'base declaration artifact\n');
  git(repo,'init','-q','-b','main');git(repo,'add','-A');git(repo,'commit','-q','-m','chore: actual main-movement base');
  if (!selective) assert.deepEqual(git(repo,'ls-files','-z','--','.tooling').split('\0').filter(Boolean).sort(),shipped.map(file=>'.tooling/'+file).sort(),'every complete installed package byte is tracked in the composed source');
  const base = git(repo,'rev-parse','HEAD'), candidate = join(scratch,'candidate');
  git(repo,'worktree','add','--detach',candidate,base);
  writeFileSync(join(candidate,'web/feature.js'),"export const feature = 'accepted';\n");
  if (generated) writeFileSync(join(candidate,'docs/lifecycle.md'),'candidate declaration artifact\n');
  git(candidate,'add','web/feature.js',...(generated?['docs/lifecycle.md']:[]));git(candidate,'commit','-q','-m','feat(web): submitted native source [C7,V4]');
  const accepted = git(candidate,'rev-parse','HEAD'), tree = git(candidate,'rev-parse','HEAD^{tree}');
  git(repo,'worktree','remove',candidate);
  const { board: store } = await import(pathToFileURL(join(installed,'apps/lib/index.js')));
  const native = await import(pathToFileURL(join(installed,'apps/lib/index.js')));
  const boardFile = join(repo,'.git','pullboard','board.sqlite');
  /** @pullboard-board-file journey: real native worker writes and private-file lifetime; close before every admitted child. */
  function board(action) { const db=native.openBoard(boardFile,undefined,{isMain:true,gitRoot:repo});try{return action(db);}finally{store.closeBoard(db);} }
  const actors = board(db => { db.executionEngineVersion=1;try{return [store.register(db,{lane:'coordinator',path:repo}),store.register(db,{lane:'web',path:join(scratch,'builder')}),store.register(db,{lane:'review',path:join(scratch,'reviewer')})];}finally{delete db.executionEngineVersion;} });
  const frozen = JSON.stringify({check,policy:{version:1,commit:base,verify:{policy:'any',family:'off'}}});
  const digest = createHash('sha256').update(frozen).digest('hex');
  const id = board(db => {
    if (outside) return store.intakeOutside(db, { agentId:'coordinator',
      source:{kind:'pull-request',repository:'fixture/project',number:1,author:'outside-author',state:'open',maintainerReplied:false,
        commit:accepted,tree,base,files:['web/feature.js'],sensitive:false},
      item:{lane:'web',title:'Outside submitted feature',criterion:'Actual feature and main behavior remain correct',check},
      frozen:{text:frozen,digest} });
    const value=store.addItem(db,{by:'coordinator',lane:'web',title:'Immutable submitted feature',criterion:'Actual feature and main behavior remain correct'});
    store.claim(db,value,{agentId:actors[1],lane:'web',leaseMs:3600000,freeze:()=>({text:frozen,digest})});
    store.submit(db,value,{agentId:actors[1],commit:accepted,tree,submissionProof:{version:1,files:[],full:false,deferred:true,reason:'historical native fixture setup, not an execution claim'}});
    if (!submitted) store.verify(db,value,{agentId:actors[2],head:accepted,digest,policy:'any',decision:'ACCEPT',note:'synthetic prior acceptance; the automatic worker must independently rerun the exact composition',
      review:{commit:accepted,head:accepted,trunk:base,paths:['web/feature.js',...(generated?['docs/lifecycle.md']:[])].sort()}});
    return value;
  });
  const original = board(db => ({item:store.getItem(db,id),verdicts:store.verdictsFor(db,id),snapshot:exportBoard(db)}));
  if (conflict) writeFileSync(join(repo,'web/feature.js'),"export const feature = 'trunk';\n");
  else writeFileSync(join(repo,'web/other.js'),`export const other = '${red?'red':'base'}'; // moved main\n`);
  if (generated) writeFileSync(join(repo,'docs/lifecycle.md'),'trunk declaration artifact\n');
  git(repo,'add','web',...(generated?['docs/lifecycle.md']:[]));git(repo,'commit','-q','-m','feat: real moved main [C7,V4]');
  const trunk = git(repo,'rev-parse','HEAD');
  const directory = join(repo,'.git','pullboard','source-advances');
  let expectedGeneration = 1;
  /** Observe actual native state and worker terminal custody, allowing live admission without a fake timer success. */
  async function settled() {
    let quietSince=Date.now(), last='';
    for (;;) {
      const rows=existsSync(directory)?readdirSync(directory).filter(name=>name.endsWith('.json')&&!['wake.json','owner.json','settled.json'].includes(name)).map(name=>JSON.parse(readFileSync(join(directory,name),'utf8'))):[];
      const ownerFile=join(directory,'owner.json');
      let owner=null;
      try { owner=JSON.parse(readFileSync(ownerFile,'utf8')); }
      catch (error) { if(error.code!=='ENOENT') throw error; }
      const signature=JSON.stringify(rows.map(row=>[row.state,row.head,row.reason]));
      if(signature!==last){last=signature;quietSince=Date.now();}
      const current=board(db=>store.getItem(db,id));
      const done=existsSync(join(directory,'settled.json'))?JSON.parse(readFileSync(join(directory,'settled.json'),'utf8')):null;
      if(!owner&&done?.generation>=expectedGeneration&&(current.item_effective_head||current.item_status==='open'||rows.some(row=>row.state==='incomplete'))) return {item:current,rows};
      let live=false;try{if(owner?.pid){process.kill(owner.pid,0);live=true;}}catch{/* A dead private owner provides no progress. */}
      if(!live&&Date.now()-quietSince>8000) assert.fail(`automatic main merge made no native progress: ${JSON.stringify({item:current,rows})}`);
      await pause(25);
    }
  }
  t.after(()=>{
    const owner=join(directory,'owner.json');
    assert.equal(existsSync(owner),false,`private worker custody remains live; preserve ${scratch}`);
    rmSync(scratch,{recursive:true,force:true});
  });
  /** The ordinary health worker is the production automatic entry point; old source has no replacement stub. */
  function trigger() { const wake=join(directory,'wake.json');expectedGeneration=(existsSync(wake)?JSON.parse(readFileSync(wake,'utf8')).generation:0)+1;const run=cli('sentinel','run','--health-only','--json');assert.equal(run.status,0,run.context ?? run.stderr);return run; }
  return {repo,installed,env,store,board,git,cli,trigger,settled,id,actors,accepted,trunk,tree,base,original,marker,directory,scratch,gateEntered,gateRelease};
}
