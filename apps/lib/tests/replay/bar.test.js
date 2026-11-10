/** Ordered bar revisions replay identically and refuse older interpretation before advancing [B4,V1,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { applyRelayMove } from '../../../../packages/state/index.js';
import { appliedSequence } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { BAR_READY_ENGINE } from '../../../../packages/state/light.js';
import { barReadiness } from '../../../../packages/verify/index.js';

const SHA='a'.repeat(40);
const ACTORS={coordinator:{session:'a'.repeat(64),parent:'a'.repeat(64)},'core-1':{session:'b'.repeat(64),parent:'a'.repeat(64)},'core-2':{session:'c'.repeat(64),parent:'c'.repeat(64)}};
/** Private SQLite copies share one initial history; all observations here are synthetic protocol fixtures. */
function copies(t) {
  const clock={now:()=>new Date('2026-10-24T00:00:00Z')};
  const first=openBoard(':memory:',clock);const second=openBoard(':memory:',clock);
  t.after(()=>{store.closeBoard(second);store.closeBoard(first);});
  store.register(first,{lane:'coordinator',path:'/private/bar-replay-root',sessionDigest:ACTORS.coordinator.session});
  for (const [index,id] of ['core-1','core-2'].entries()) store.register(first,{lane:'core',path:`/private/bar-replay-${index}`,sessionDigest:ACTORS[id].session,parentDigest:ACTORS[id].parent});
  importBoard(second,exportBoard(first));return [first,second];
}
/** Normal ordered moves carry the captured actor and replay without reading either machine's runtime. */
function dispatch(boards,operation,args,by='coordinator',person=false) {
  const sequence=appliedSequence(boards[0])+1;
  const move=prepareEngineMove(boards[0],operation,args,{id:`bar-replay-${sequence}`,actor:by});
  const sender=person ? {kind:'person',userId:'private-fixture',login:'private-fixture'} : {kind:'agent',userId:'private-fixture',agent:by};
  const options={sequence,at:`2026-10-24T00:00:${String(sequence).padStart(2,'0')}Z`,kind:'move',sender};
  const results=boards.map(board=>applyRelayMove(board,move,options));
  assert.deepEqual(results[0],results[1]);assert.equal(results[0].error,undefined,JSON.stringify(results[0]));
  assert.deepEqual(exportBoard(boards[0]).tables,exportBoard(boards[1]).tables);
  return results[0].result;
}
/** A deliberately synthetic red witness tests sealing; actual native baseline execution lives in the CLI file. */
function item(person=false) {
  const check='node --test --test-name-pattern "named witness" test/a.test.js';
  return {by:'coordinator',lane:'core',title:'Replayable bar',criterion:'the named witness passes',route:'mid',check,
    brief:'Files: src/a.js\nTest: named witness asserts the behavior\nNamed test: named witness\nMeasurements: no quantitative bounds\nReviewer edges: empty and changed input',
    barActor:person ? {authority:'person',session:null,parent:null} : ACTORS.coordinator,
    checkBaseline:{command:check,main:SHA,result:'red',testEvidence:{failed:['named witness'],passed:[],noTestsMatched:false}}};
}
/** Sign exact captured words, not a receiver's current checkout or evidence paths. */
function signature(board,id,agent='core-2') {
  const current=store.getItem(board,id);const status=barReadiness(board,current, {}, board.runtimePorts.verification);
  return {agentId:agent,barActor:ACTORS[agent],revision:status.revision.revision,digest:status.revision.digest,note:'The synthetic protocol bar has explicit evidence and edges.',
    coverage:{version:1,sourceMain:SHA,sourceCheck:current.item_check,policyKey:'d'.repeat(64),timeoutMs:300000,runner:'node --test',required:[],files:[]}};
}

test('[B4,V1,H16] readiness activation, authored revision, signature and claim replay in two independent SQLite copies',t=>{
  const boards=copies(t);dispatch(boards,'setBarReady',[{agentId:'coordinator',enabled:true}]);
  const id=dispatch(boards,'addItem',[item()]);
  const sealed=prepareEngineMove(boards[0],'claim',[id,{agentId:'core-1',lane:'core',leaseMs:7200000,freeze:()=>({text:'{"rows":[]}',digest:'e'.repeat(64)})}],{id:'too-old-bar-claim',actor:'core-1'});
  assert.throws(()=>applyRelayMove(boards[0],{...sealed,engine:BAR_READY_ENGINE-1},{sequence:3,at:'2026-10-24T00:00:03Z',kind:'move',sender:{kind:'agent',userId:'private-fixture',agent:'core-1'}}),/RELAY_MOVE/);
  assert.equal(appliedSequence(boards[0]),2,'a downgraded claim cannot advance or evade the readiness boundary');
  dispatch(boards,'signBar',[id,signature(boards[0],id)],'core-2');
  const text=JSON.stringify({title:'Replayable bar',criterion:'the named witness passes',check:store.getItem(boards[0],id).item_check,rows:[]});
  dispatch(boards,'claim',[id,{agentId:'core-1',lane:'core',leaseMs:7200000,freeze:()=>({text,digest:createHash('sha256').update(text).digest('hex')})}],'core-1');
  assert.equal(store.getItem(boards[1],id).item_owner,'core-1');
  assert.equal(barReadiness(boards[1],store.getItem(boards[1],id), {}, boards[1].runtimePorts.verification).missing.length,0);
});

test('[B26,V1,H16] a person-authority revision and agent signature replay without manufacturing a parent',t=>{
  const boards=copies(t);dispatch(boards,'setBarReady',[{agentId:'coordinator',enabled:true}]);
  const id=dispatch(boards,'addItem',[item(true)],'coordinator',true);
  dispatch(boards,'signBar',[id,signature(boards[0],id,'core-1')],'core-1');
  const status=barReadiness(boards[1],store.getItem(boards[1],id), {}, boards[1].runtimePorts.verification);
  assert.equal(status.missing.length,0);
  assert.ok(Object.values(status.revision.authors).every(author=>author.authority==='person' && author.parent===null && author.session===null));
});

test('bar readiness reads a real SQLite query view without native capabilities [C7,B4,V1]', t => {
  const [board] = copies(t);
  store.setBarReady(board, { agentId: 'coordinator', enabled: true });
  const id = store.addItem(board, item());
  const row = store.getItem(board, id);
  const before = exportBoard(board).tables;
  const raw = { db: board.db };
  let calls = 0;
  const services = {
    /** Forward the exact supplied query view to the canonical baseline reader. */
    itemCheckBaseline(current, item) {
      assert.equal(current, raw);
      calls++;
      return board.runtimePorts.verification.itemCheckBaseline(current, item);
    },
  };
  assert.deepEqual(barReadiness(raw, row, {}, services), barReadiness(board, row, {}, board.runtimePorts.verification));
  assert.equal(calls, 1);
  assert.equal('nativePorts' in raw, false);
  assert.equal('runtimePorts' in raw, false);
  assert.deepEqual(exportBoard(board).tables, before, 'query presentation changes no recorded state');
});
