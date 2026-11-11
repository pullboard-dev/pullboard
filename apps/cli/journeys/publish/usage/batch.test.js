/** @pullboard-test-input source-tree */
/** Pending historical usage publishes once without extending the lifecycle writer [N2,C7,H16]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { logEvent } from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { storedSeatUsage } from '../../../../../packages/stats/index.js';
import { USAGE_BATCH_LIMIT } from '../../../../../packages/stats/index.js';
import { USAGE_BATCH_ENGINE } from '../../../../../packages/state/light.js';
import { prepareEngineMove } from '../../../../../packages/state/index.js';
import { applyEngineMove } from '../../../../../packages/state/index.js';
import { declaredMoveActor } from '../../../../../packages/moves/index.js';
import { minimumMoveEngine } from '../../../../../packages/moves/index.js';

/** A private joined repository and historical events are fixture data, not measured provider usage. */
function fixture(t, count = 48) {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const who = box.run(box.web, 'whoami', '--json');
  assert.equal(who.code, 0, who.err);
  const agent = JSON.parse(who.out).id;
  // @pullboard-board-file journey: actual CLI and replay share this private repository board.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const ids = [];
  const start = Date.now() - 100000;
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  store.atomic(board, () => {
  for (let n = 0; n <= count; n++) {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Usage batch ${n}`, specIds: ['G1'],
      criterion: 'Usage stays attributed once.', check: 'test -f web/ready',
      checkBaseline: { command: 'test -f web/ready', result: 'red', main, seconds: 0 } });
    ids.push(id);
    if (n < count) {
      logEvent(board, agent, 'claim', id, { model: 'unknown', leaseUntil: new Date(start + n * 100 + 90).toISOString() }, new Date(start + n * 100));
      logEvent(board, agent, 'release', id, {}, new Date(start + n * 100 + 50));
    }
  }
  });
  return { box, helpers, board, agent, ids };
}

test('a real claim publishes all 48 pending revisions in one transaction and retries without duplicates [N2,C7]', t => {
  const { box, helpers, board, agent, ids } = fixture(t);
  t.after(() => store.closeBoard(board));
  const cli = pathToFileURL(join(helpers.BIN, '../../cli/index.js')).href;
  const checkpoint = pathToFileURL(join(helpers.BIN, '../../../packages/stats/src/io/cost/checkpoint.js')).href;
  const code = `import {context,withBoard,whoAmI,cli\$claimOrdered as claimOrdered,cli\$freezer as freezer,cli\$ordered as ordered} from ${JSON.stringify(cli)};
    import {publishUsage} from ${JSON.stringify(checkpoint)};
    import * as nativeBoard from ${JSON.stringify(new URL('../../../../lib/index.js', import.meta.url).href)};
    const io={cwd:process.cwd(),nativeBoard,say(){},err(message){process.stderr.write(message+'\\n');}};
    const ctx=context(io),holds=[],operations=[];io.onOrderedMove=event=>operations.push(event.operation);
    await withBoard(ctx,async board=>{
      const exec=board.db.exec.bind(board.db);let acquired=null;
      board.db.exec=sql=>{const result=exec(sql);if(sql==='BEGIN IMMEDIATE')acquired=performance.now();
        if(sql==='COMMIT'&&acquired!==null){holds.push(performance.now()-acquired);acquired=null;}return result;};
      const agent=whoAmI(ctx,board).id;
      await claimOrdered(ctx,board,[${ids.at(-1)},{agentId:agent,lane:'web',leaseMs:60000,freeze:freezer(ctx,{board})}]);
      await publishUsage(ctx,board,{agent,item:${ids.at(-1)},operation:'claim'},{ordered});
    });console.log(JSON.stringify({holds,operations}));`;
  const env = { ...box.env, CODEX_HOME: join(box.dir, 'codex'), CLAUDE_CONFIG_DIR: join(box.dir, 'claude') };
  for (const key of ['CODEX_THREAD_ID','CODEX_SESSION_ID','CLAUDE_CODE_SESSION_ID','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','AI_AGENT','CODEX_CI','CODEX_SHELL']) delete env[key];
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', code], { cwd: box.web, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { holds, operations } = JSON.parse(result.stdout);
  t.diagnostic(`actual SQLite holds milliseconds: ${JSON.stringify(holds)}`);
  assert.equal(operations.filter(value => value === 'recordUsageBatch').length, 1);
  assert.ok(holds.length >= 2, 'the lifecycle and usage have separate actual transactions');
  assert.ok(Math.max(...holds) < 1000, `actual SQLite lock holds ${JSON.stringify(holds)} ms`); // budget: frozen #1867 under-one-second hold.
  const usage = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='usage'").all().map(row => JSON.parse(row.event_detail));
  assert.equal(usage.length, 48);
  assert.deepEqual(usage.map(row => row.item).sort((a,b)=>a-b), ids.slice(0,48));
  assert.equal(store.getItem(board,ids.at(-1)).item_owner, agent);
  assert.ok(usage.every(row => row.records[0].wallMs === 50));
});

test('usage batches retain authentication, atomic rollback, per-record deduplication and replay floor [N2,H16]', t => {
  const { board, agent, ids } = fixture(t, 2); t.after(() => store.closeBoard(board));
  const record = item => ({agentId:agent,item,revision:1,observedAt:1,records:[{model:'fixture',inputTokens:1,outputTokens:2,
    knownInputTokens:1,knownOutputTokens:2,wallMs:3,unknownReasons:[]}]});
  const items=ids.slice(0,2).map(record),payload={agentId:agent,items};
  assert.throws(()=>store.recordUsageBatch(board,{...payload,privateSession:'must never seal'}),{code:'USAGE_RECORD'});
  assert.throws(()=>store.recordUsageBatch(board,{...payload,items:[{...items[0],privatePath:'must never seal'}]}),{code:'USAGE_RECORD'});
  assert.throws(()=>store.recordUsageBatch(board,{...payload,items:[items[0],{...items[1],agentId:'foreign'}]}),{code:'USAGE_RECORD'});
  assert.throws(()=>store.recordUsageBatch(board,{...payload,items:[items[0],{...items[1],revision:0}]}),{code:'USAGE_RECORD'});
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='usage'").get().n,0);
  store.recordUsageBatch(board,payload);store.recordUsageBatch(board,payload);
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='usage'").get().n,2);
  assert.throws(()=>store.recordUsageBatch(board,{...payload,items:[{...items[0],observedAt:2}]}),{code:'USAGE_CHANGED'});
  assert.equal(minimumMoveEngine('recordUsageBatch',[payload]),USAGE_BATCH_ENGINE);
  const move=prepareEngineMove(board,'recordUsageBatch',[payload],{actor:agent});
  assert.equal(declaredMoveActor(move),agent);
  const receipt=applyEngineMove(board,move,{sequence:1,at:new Date().toISOString()});
  assert.deepEqual(applyEngineMove(board,move,{sequence:1,at:new Date().toISOString()}),receipt);
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='usage'").get().n,2);
  board.executionEngineVersion=USAGE_BATCH_ENGINE-1;
  assert.throws(()=>store.recordUsageBatch(board,payload),{code:'ENGINE_VERSION'});
});


test('1001 pending revisions progress across bounded commands and never duplicate or disappear [N2,C7,H16]', t => {
  const {box,helpers,board,agent,ids}=fixture(t,USAGE_BATCH_LIMIT+1);
  t.after(()=>store.closeBoard(board));
  const cli=pathToFileURL(join(helpers.BIN,'../../cli/index.js')).href;
  const checkpoint=pathToFileURL(join(helpers.BIN,'../../../packages/stats/src/io/cost/checkpoint.js')).href;
  const code=`import {context,withBoard,whoAmI,cli\$ordered as ordered} from ${JSON.stringify(cli)};
    import {publishUsage} from ${JSON.stringify(checkpoint)};
    import * as nativeBoard from ${JSON.stringify(new URL('../../../../lib/index.js', import.meta.url).href)};
    const operations=[],io={cwd:process.cwd(),nativeBoard,say(){},err(message){process.stderr.write(message+'\\n');},onOrderedMove(event){operations.push(event.operation);}};
    const ctx=context(io);await withBoard(ctx,board=>publishUsage(ctx,board,{agent:whoAmI(ctx,board).id,operation:'refresh'},{ordered}));
    console.log(JSON.stringify({operations}));`;
  const env={...box.env,CODEX_HOME:join(box.dir,'codex'),CLAUDE_CONFIG_DIR:join(box.dir,'claude')};
  for(const key of ['CODEX_THREAD_ID','CODEX_SESSION_ID','CLAUDE_CODE_SESSION_ID','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','AI_AGENT','CODEX_CI','CODEX_SHELL'])delete env[key];
  const run=()=>{
    const result=runFixtureChild(process.execPath,['--input-type=module','-e',code],{cwd:box.web,env,encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);
    return {...result,...JSON.parse(result.stdout)};
  };
  const count=()=>board.db.prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='usage'").get().n;
  const first=run();
  assert.deepEqual(first.operations,['recordUsageBatch']);
  assert.equal(count(),USAGE_BATCH_LIMIT);
  assert.match(first.stderr,/1 remain for the next native claim/);
  const second=run();
  assert.deepEqual(second.operations,['recordUsageBatch']);
  assert.equal(count(),USAGE_BATCH_LIMIT+1);
  assert.deepEqual(run().operations,[]);
  assert.equal(count(),USAGE_BATCH_LIMIT+1,'fresh-process retry cannot duplicate acknowledged revisions');
  const totals=storedSeatUsage(board,agent);
  assert.deepEqual(totals.map(row=>row.item).sort((a,b)=>a-b),ids.slice(0,USAGE_BATCH_LIMIT+1));
  assert.ok(totals.every(row=>row.records[0].wallMs===50),'the unsent tail retains its exact private numeric totals');
});


/** Seed public-shaped history, not copied board data or private provider records. */
function seedFamilyScale(board, directory) {
  const at='2026-10-01T00:00:00.000Z';
  const agent=board.db.prepare('INSERT INTO agent(agent_id,agent_lane,agent_path,agent_created_at,agent_family) VALUES(?,?,?,?,?)');
  const event=board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES(?,?,?,NULL,?)');
  const meta=board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?)');
  store.atomic(board,()=>{
    for(let n=0;n<1221;n++){
      const id=`scale-seat-${n}`,path=join(directory,id);
      agent.run(id,'web',path,at,'fixture-family');
      event.run(at,id,'join',JSON.stringify(n<74?{path}:{path,family:'fixture-family'}));
      if(n<74)event.run(at,id,'family',JSON.stringify({family:null}));
      if(n<254)meta.run(`agent_session:${id}`,String(n+1).padStart(64,'0'));
      if(n<192)meta.run(`relay_receipt_scale-${n}`,JSON.stringify({sequence:n+1,
        move:JSON.stringify({operation:'register',args:[{path,family:'fixture-family'}]}),outcome:{result:id}}));
    }
    for(let n=0;n<100000;n++)event.run(at,`scale-seat-${n%1221}`,'fact',JSON.stringify({id:`scale-fact-${n}`,kind:'note',text:'synthetic historical fact'}));
  });
}

test('48 revisions hold the production writer under one second with 1221 seats and real-shaped family history [N2,C7,H16]',t=>{
  const f=fixture(t);let board=f.board;
  t.after(()=>store.closeBoard(board));
  seedFamilyScale(board,f.box.dir);
  // Opening the persisted board warms its proof projection exactly as a normal native opener does.
  store.closeBoard(board);
  // @pullboard-board-file journey: reopen the same private persisted fixture to warm its native proof projection.
  board=openBoard(join(f.box.repo,'.git','pullboard','board.sqlite'));
  const prepare=board.db.prepare.bind(board.db),exec=board.db.exec.bind(board.db);
  let familyScans=0,acquired=null;const holds=[];
  board.db.prepare=sql=>{if(sql.includes('SELECT agent.*, model.meta_value'))familyScans++;return prepare(sql);};
  board.db.exec=sql=>{const result=exec(sql);if(sql==='BEGIN IMMEDIATE')acquired=performance.now();
    if(sql==='COMMIT'&&acquired!==null){holds.push(performance.now()-acquired);acquired=null;}return result;};
  const records=[{model:'scale-fixture',inputTokens:1,outputTokens:2,knownInputTokens:1,knownOutputTokens:2,wallMs:3,unknownReasons:[]}];
  const items=f.ids.slice(0,48).map(item=>({agentId:f.agent,item,revision:1,observedAt:1,records}));
  store.recordUsageBatch(board,{agentId:f.agent,items});
  assert.equal(holds.length,1);
  assert.ok(holds[0]<1000,`real-shaped history writer held ${holds[0]} ms`); // budget: frozen #1867 under-one-second real-scale hold.
  assert.equal(familyScans,0,'membership must not derive unrelated seat families');
  store.recordUsageBatch(board,{agentId:f.agent,items});
  assert.equal(prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='usage'").get().n,48);
  assert.throws(()=>store.recordUsageBatch(board,{agentId:'unregistered-scale-seat',items:[]}),{code:'NOT_JOINED'});
  assert.throws(()=>store.recordUsage(board,{...items[0],agentId:'unregistered-scale-seat'}),{code:'NOT_JOINED'});
  const counts={agents:prepare('SELECT COUNT(*) AS n FROM agent').get().n,events:prepare('SELECT COUNT(*) AS n FROM event').get().n,
    family:prepare("SELECT COUNT(*) AS n FROM event WHERE event_kind='family'").get().n,
    sessions:prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key LIKE 'agent_session:%'").get().n,
    receipts:prepare("SELECT COUNT(*) AS n FROM board_meta WHERE meta_key LIKE 'relay_receipt_%'").get().n};
  t.diagnostic(`deterministic history ${JSON.stringify(counts)}; actual batch hold ${holds[0]} ms`);
});
