/** @pullboard-test-input source-tree */
/** Pending historical usage publishes once without extending the lifecycle writer [N2,C7,H16]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as store from '../src/board.js';
import { logEvent } from '../src/board-event-log.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { USAGE_BATCH_ENGINE } from '../src/usage-batch-engine.js';
import { prepareEngineMove } from '../src/engine.js';
import { applyEngineMove } from '../src/engine.js';
import { declaredMoveActor } from '../src/move-registry.js';
import { minimumMoveEngine } from '../src/move-registry.js';

/** A private joined repository and historical events are fixture data, not measured provider usage. */
function fixture(t, count = 48) {
  const helpers = createE2eHelpers(); t.after(helpers.cleanup);
  const box = helpers.project('true');
  const who = box.run(box.web, 'whoami', '--json');
  assert.equal(who.code, 0, who.err);
  const agent = JSON.parse(who.out).id;
  // @pullboard-board-file journey: actual CLI and replay share this private repository board.
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const ids = [];
  const start = Date.now() - 100000;
  for (let n = 0; n <= count; n++) {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Usage batch ${n}`, specIds: ['G1'],
      criterion: 'Usage stays attributed once.', check: 'test -f web/ready',
      checkBaseline: { command: 'test -f web/ready', result: 'red', main: box.git(box.repo, 'rev-parse', 'HEAD'), seconds: 0 } });
    ids.push(id);
    if (n < count) {
      logEvent(board, agent, 'claim', id, { model: 'unknown', leaseUntil: new Date(start + n * 100 + 90).toISOString() }, new Date(start + n * 100));
      logEvent(board, agent, 'release', id, {}, new Date(start + n * 100 + 50));
    }
  }
  return { box, helpers, board, agent, ids };
}

test('a real claim publishes all 48 pending revisions in one transaction and retries without duplicates [N2,C7]', t => {
  const { box, helpers, board, agent, ids } = fixture(t);
  t.after(() => store.closeBoard(board));
  const cli = pathToFileURL(join(helpers.BIN, '../../src/cli.js')).href;
  const checkpoint = pathToFileURL(join(helpers.BIN, '../../src/cost-checkpoint.js')).href;
  const code = `import {context,withBoard,whoAmI,claimOrdered,freezer} from ${JSON.stringify(cli)};
    import {publishUsage} from ${JSON.stringify(checkpoint)};
    const io={cwd:process.cwd(),say(){},err(message){process.stderr.write(message+'\\n');}};
    const ctx=context(io),holds=[],operations=[];io.onOrderedMove=event=>operations.push(event.operation);
    await withBoard(ctx,async board=>{
      const exec=board.db.exec.bind(board.db);let acquired=null;
      board.db.exec=sql=>{const result=exec(sql);if(sql==='BEGIN IMMEDIATE')acquired=performance.now();
        if(sql==='COMMIT'&&acquired!==null){holds.push(performance.now()-acquired);acquired=null;}return result;};
      const agent=whoAmI(ctx,board).id;
      await claimOrdered(ctx,board,[${ids.at(-1)},{agentId:agent,lane:'web',leaseMs:60000,freeze:freezer(ctx,{board})}]);
      await publishUsage(ctx,board,{agent,item:${ids.at(-1)},operation:'claim'});
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
