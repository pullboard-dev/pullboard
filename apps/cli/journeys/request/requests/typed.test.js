/** Typed requests retain coordinator authority, native execution evidence and ordered replay [B3,N26,H16]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { fixtureBoard } from '../../../tests/fixtures/board.js';
import {
  appliedSequence,
  applyRelayMove,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../../packages/store/index.js';
import { TYPED_REQUESTS_ENGINE } from '../../../../../packages/state/light.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { orderedMoveCommand } from '../../../../../packages/link/index.js';
import { requestedCommandMove } from '../../../../../packages/state/index.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Logic-only replicas use the shared SQLite memory contract; no rows or proof receipts are fabricated. */
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'pullboard typed requests '));
  const board=fixtureBoard(t);
  store.register(board,{lane:'coordinator',path:join(directory,'main'),createdBy:'coordinator'});
  const agent=store.register(board,{lane:'web',path:join(directory,'web'),createdBy:'coordinator'});
  const item=store.addItem(board,{by:'coordinator',lane:'web',title:'Concrete requested work',criterion:'The route can build the named change',check:'node --test test/routed.test.js',brief:'Files:\n- web/a.js\nChange: update the named function\nTest: test/routed.test.js checks its behavior'});
  t.after(()=>{rmSync(directory,{recursive:true,force:true});});
  return {board,agent,item,directory};
}

/** Capture exact native history to prove refusal and retry never partially mutate the queue or target. */
function history(board){return store.events(board);}

/** Exercise the actual parsed CLI and require one versioned JSON document. */
function cli(box,cwd,...args){const r=box.run(cwd,...args,'--json');assert.equal(r.code,0,r.err+r.out);const d=JSON.parse(r.out);assert.equal(d.version,1);return d;}

/** Read genuine native operation events produced by the original coordinator commands. */
// @pullboard-board-file journey: read the durable native events written by the preceding separate coordinator CLI commands.
function eventFor(box,item,kind){const board=openBoard(join(box.repo,'.git/pullboard/board.sqlite'));try{return history(board).findLast(row=>row.item_id===item&&row.event_kind===kind).event_id;}finally{store.closeBoard(board);}}

test('actual CLI files, lists, delivers and batch-answers typed coordinator requests [B3,N26]',()=>{
  const box=helpers.project('true');
  const first=cli(box,box.repo,'add','web','Hold target').item.item_id;
  const second=cli(box,box.repo,'add','web','Withdraw target').item.item_id;
  const missing=box.run(box.web,'request','hold',String(first),'--json');
  assert.notEqual(missing.code,0);assert.equal(JSON.parse(missing.out).error.code,'BAD_REQUEST_CAUSE');
  const a=cli(box,box.web,'request','hold',String(first),'--cause','routing-assignment','--note','Wait for the dependency').id;
  const b=cli(box,box.web,'request','withdraw',String(second),'--cause','tool-defect').id;
  assert.equal(cli(box,box.repo,'show',String(first)).item_hold_reason,null,'request alone never executes a hold');
  assert.equal(cli(box,box.repo,'show',String(second)).item_status,'open','request alone never withdraws');
  assert.deepEqual(cli(box,box.web,'request','list').requests.map(row=>row.id),[a,b]);
  const inbox=cli(box,box.repo,'inbox');
  assert.ok(inbox.activity.entries.some(row=>row.typedRequest&&row.eventId===a),'coordinator receives typed queue activity');
  const denied=box.run(box.web,'request','answer',`${a},${b}`,'declined','--note','Forged coordinator','--json');
  assert.notEqual(denied.code,0);assert.equal(JSON.parse(denied.out).error.code,'COORDINATOR_ONLY');
  cli(box,box.repo,'hold',String(first),'--reason','Dependency holds it');
  cli(box,box.repo,'withdraw',String(second),'Superseded requirement');
  const events=[eventFor(box,first,'hold_item'),eventFor(box,second,'withdraw')];
  const answered=cli(box,box.repo,'request','answer',`${a},${b}`,'done','--acted-on',events.join(','));
  assert.deepEqual(answered.requests.map(row=>row.status),['done','done']);
  assert.equal(cli(box,box.repo,'request','list').requests.length,0);
  assert.equal(cli(box,box.web,'request','list','--all').requests.length,2);
  const reply=cli(box,box.web,'inbox');
  assert.ok(reply.activity.entries.some(row=>row.typedRequest&&row.text.includes(`#${a} done`)),'requester receives actual answer activity');
  cli(box,box.repo,'hold',String(first),'--off');
  assert.deepEqual(cli(box,box.repo,'request','answer',`${a},${b}`,'done','--acted-on',events.join(',')).requests,answered.requests,'exact retry retains original result after later legitimate state changes');
});

test('malformed causes, targets, verbs and authority fields refuse without creating requests [B3,N26]',t=>{
  const {board,agent,item}=fixture(t),before=history(board),target=store.getItem(board,item);
  for(const change of [{cause:undefined},{cause:'model-invented-key'},{itemId:0},{itemId:999999},{verb:'approve-spec'},
    {agentId:'unknown'},{asPerson:true},{verb:'hold',route:'light'},{verb:'reroute',route:'imaginary'}]){
    assert.throws(()=>store.fileTypedRequest(board,{agentId:agent,verb:'hold',itemId:item,cause:'routing-assignment',...change}));
    assert.deepEqual(history(board),before);assert.deepEqual(store.getItem(board,item),target);
  }
  board.executionEngineVersion=TYPED_REQUESTS_ENGINE-1;
  try{assert.throws(()=>store.fileTypedRequest(board,{agentId:agent,verb:'hold',itemId:item,cause:'routing-assignment'}),{code:'ENGINE_VERSION'});}
  finally{delete board.executionEngineVersion;}
  assert.deepEqual(store.allShouts(board),[],'typed requests never impersonate person requests or decision shouts');
});

test('batch answers validate every row and cannot close unfinished, wrong-item or reversed work [B3,N26,H16]',t=>{
  const {board,agent,item}=fixture(t),other=store.addItem(board,{by:'coordinator',lane:'web',title:'Other target'});
  store.holdItem(board,item,{agentId:'coordinator',reason:'Old hold'});const old=board.lastEvent.event_id;
  const a=store.fileTypedRequest(board,{agentId:agent,verb:'hold',itemId:item,cause:'routing-assignment'});
  const b=store.fileTypedRequest(board,{agentId:agent,verb:'withdraw',itemId:other,cause:'bar-ambiguity'});
  store.holdItem(board,other,{agentId:'coordinator',reason:'Wrong item'});const wrong=board.lastEvent.event_id;
  const before=history(board);
  for(const eventId of [old,wrong,a])assert.throws(()=>store.answerTypedRequests(board,{agentId:'coordinator',answers:[{requestId:a,outcome:'done',eventId}]}),{code:'REQUEST_NOT_ACTED'});
  assert.throws(()=>store.answerTypedRequests(board,{agentId:'coordinator',answers:[{requestId:a,outcome:'declined',note:'Not needed'},{requestId:b,outcome:'done',eventId:wrong}]}),{code:'REQUEST_NOT_ACTED'});
  assert.deepEqual(history(board),before,'invalid later answer leaves the whole batch unchanged');
  assert.throws(()=>store.answerTypedRequests(board,{agentId:'coordinator',answers:[{requestId:a,outcome:'declined'}]}));
  store.holdItem(board,item,{agentId:'coordinator',reason:'Requested new hold'});const actual=board.lastEvent.event_id;
  store.releaseItemHold(board,item,{agentId:'coordinator'});
  assert.throws(()=>store.answerTypedRequests(board,{agentId:'coordinator',answers:[{requestId:a,outcome:'done',eventId:actual}]}),{code:'REQUEST_NOT_ACTED'});
  const answers=[{requestId:a,outcome:'declined',note:'No longer needed'},{requestId:b,outcome:'declined',note:'Keep the target'}];
  const result=store.answerTypedRequests(board,{agentId:'coordinator',answers}),after=history(board);
  assert.deepEqual(store.answerTypedRequests(board,{agentId:'coordinator',answers}),result);assert.deepEqual(history(board),after);
  assert.throws(()=>store.answerTypedRequests(board,{agentId:'coordinator',answers:[{...answers[0],note:'Changed history'}]}),{code:'REQUEST_ALREADY_ANSWERED'});
});

test('reopen and reroute completion bind actual coordinator lifecycle and exact tier changes [B3,N26,H16]',t=>{
  const {board,agent,item}=fixture(t);
  // Synthetic submission is explicitly only a lifecycle precondition, never runtime gate evidence.
  store.claim(board,item,{agentId:agent,lane:'web',leaseMs:3600000,freeze:()=>({text:'{"rows":[]}',digest:'typed-fixture-bar'})});
  submitFixture(board,item,{agentId:agent,commit:'a'.repeat(40),tree:'b'.repeat(40)});
  const reopen=store.fileTypedRequest(board,{agentId:agent,verb:'reopen',itemId:item,cause:'bar-ambiguity'});
  store.reopen(board,item,{agentId:'coordinator',note:'Correct the frozen criterion'});const reopened=board.lastEvent.event_id;
  const reroute=store.fileTypedRequest(board,{agentId:agent,verb:'reroute',itemId:item,cause:'routing-assignment',route:'mid'});
  // A light route needs a recorded diagnosis first (light-route diagnosis rule, e3ff15e335).
  store.appendFact(board,item,{agentId:'coordinator',kind:'diagnosis',text:'Files: web/a.js Change: update the named function Test case: test/routed.test.js checks its behavior'});
  store.editItem(board,item,{agentId:'coordinator',route:'light'});const wrong=board.lastEvent.event_id;
  assert.throws(()=>store.answerTypedRequests(board,{agentId:'coordinator',answers:[{requestId:reroute,outcome:'done',eventId:wrong}]}),{code:'REQUEST_NOT_ACTED'});
  store.editItem(board,item,{agentId:'coordinator',route:'mid'});const routed=board.lastEvent.event_id;
  assert.deepEqual(store.answerTypedRequests(board,{agentId:'coordinator',answers:[{requestId:reopen,outcome:'done',eventId:reopened},{requestId:reroute,outcome:'done',eventId:routed}]}).map(row=>row.status),['done','done']);
});

test('authenticated replicas preserve typed requests, exact retries and an enforced new engine floor [B3,N26,H16]',t=>{
  const {board,agent,item}=fixture(t),replica=fixtureBoard(t);
  importBoard(replica,exportBoard(board));
  const move=prepareEngineMove(board,'fileTypedRequest',[{agentId:agent,verb:'hold',itemId:item,cause:'routing-assignment'}]);
  const options={sequence:1,at:'2026-10-27T08:00:00Z',kind:'move',sender:{kind:'agent',agent,userId:'typed-fixture'}};
  assert.throws(()=>applyRelayMove(replica,{...move,engine:TYPED_REQUESTS_ENGINE-1},options));
  assert.equal(appliedSequence(replica),0);
  const forged=[board,replica].map(target=>applyRelayMove(target,{...move,id:'forged-request'},{...options,sender:{...options.sender,agent:'coordinator'}}));
  assert.deepEqual(forged[0],forged[1]);assert.equal(forged[0].error.code,'RELAY_SENDER_MISMATCH');assert.equal(store.typedRequests(replica).length,0);
  const outcomes=[board,replica].map(target=>applyRelayMove(target,move,{...options,sequence:2}));
  assert.deepEqual(outcomes[0],outcomes[1]);assert.equal(outcomes[0].error,undefined);
  assert.deepEqual(store.typedRequests(board),store.typedRequests(replica));
  assert.deepEqual(applyRelayMove(replica,move,{...options,sequence:2}),outcomes[1]);
  const answer=prepareEngineMove(board,'answerTypedRequests',[{agentId:'coordinator',answers:[{requestId:outcomes[0].result,outcome:'declined',note:'Keep the item'}]}]);
  const response=[board,replica].map(target=>applyRelayMove(target,answer,{...options,sequence:3,sender:{...options.sender,agent:'coordinator'}}));
  assert.equal(response[0].error,undefined);assert.deepEqual(response[0],response[1]);
  assert.deepEqual(store.typedRequests(board,{all:true}),store.typedRequests(replica,{all:true}));
  assert.equal(requestedCommandMove('request','fileTypedRequest'),true);assert.equal(requestedCommandMove('request','answerTypedRequests'),true);
  assert.equal(orderedMoveCommand({relayCommand:{cliOperation:'request',positionals:['list']}}),false);
  assert.equal(orderedMoveCommand({relayCommand:{cliOperation:'request',positionals:['hold',String(item)]}}),true);
});
