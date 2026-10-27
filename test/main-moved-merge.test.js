/** @pullboard-test-input source-tree */
/** Actual automatic main movement retains assurance only after real nondeferred checks [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportBoard } from '../src/exchange.js';
import { importBoard } from '../src/exchange.js';
import { test } from 'node:test';
import { mainMovedFixture } from './main-moved-fixture.js';

/** Read the native checked source and immutable receipts after the independent worker has drained. */
function state(box) { return box.board(board=>({item:box.store.getItem(board,box.id),verdicts:box.store.verdictsFor(board,box.id),
  accepted:box.store.acceptedVerdict(board,box.store.getItem(board,box.id)),events:box.store.events(board,{itemId:box.id}),
  landing:box.store.checkedLandingCommit(board,box.store.getItem(board,box.id)),proofs:box.store.proofReceipts(board,box.id)})); }

test('a clean main move keeps the accepted verdict on its genuinely checked merged head [C7,V4,H16]',{timeout:180000},async t=>{
  const box=await mainMovedFixture(t);box.trigger();const terminal=await box.settled();
  assert.equal(terminal.item.item_status,'verified',JSON.stringify(terminal.rows));
  const now=state(box);assert.notEqual(now.item.item_effective_head,undefined);
  assert.equal(now.item.item_commit,box.accepted,'the submitted source remains immutable');
  assert.deepEqual(now.verdicts,box.original.verdicts,'no new or rewritten verdict substitutes for the original independent decision');
  assert.equal(now.accepted.verdict_id,box.original.verdicts.at(-1).verdict_id);
  assert.equal(now.accepted.review.head,now.item.item_effective_head);assert.equal(now.landing,now.item.item_effective_head);
  assert.deepEqual(box.git(box.repo,'show','-s','--format=%P',now.landing).split(' '),[box.accepted,box.trunk]);
  assert.equal(box.git(box.repo,'rev-parse','HEAD'),box.trunk,'the real coordinator checkout did not move');
  assert.equal(box.git(box.repo,'status','--porcelain'),'','the live checkout and index remain unchanged');
  assert.equal(now.events.filter(row=>row.event_kind==='source_advanced').length,1);
  assert.equal(now.events.filter(row=>row.event_kind==='reopen').length,0);
  assert.equal(now.proofs.length,2,'criterion and affected/full scope actually executed separately despite submit deferral policy');
  assert.ok(now.proofs.every(row=>row.commit===now.landing&&row.exitCode===0&&row.sourceClean));
  assert.equal(readFileSync(box.marker,'utf8').trim().split('\n').length,2,'real bodies ran; no receipt, stamp or test-cache result stands in');
  const before=box.board(board=>box.store.events(board).length);box.trigger();await box.settled();
  assert.equal(box.board(board=>box.store.events(board).filter(row=>row.event_kind==='source_advanced').length),1);
  assert.equal(readFileSync(box.marker,'utf8').trim().split('\n').length,2,'a settled exact source is never rechecked on an unchanged health wake');
  assert.ok(box.board(board=>box.store.events(board).length)>=before);
});

test('only a generated lifecycle conflict is regenerated and retains the accepted place [C7,V4,H16]',{timeout:180000},async t=>{
  const box=await mainMovedFixture(t,{generated:true});box.trigger();const terminal=await box.settled();
  assert.equal(terminal.item.item_status,'verified',JSON.stringify(terminal.rows));const now=state(box);
  const generated=box.cli('lifecycle');assert.equal(generated.status,0,generated.stderr);
  assert.equal(box.git(box.repo,'show',`${now.landing}:docs/lifecycle.md`),generated.stdout.trim());
  assert.deepEqual(now.verdicts,box.original.verdicts);assert.equal(now.events.filter(row=>row.event_kind==='reopen').length,0);
  const detail=JSON.parse(now.events.find(row=>row.event_kind==='source_advanced').event_detail);
  assert.deepEqual(detail.generated,['docs/lifecycle.md']);assert.equal(now.item.item_commit,box.accepted);
});

test('a real source conflict reopens the same item with its exact file and leaves the verdict immutable [C7,V4,H16]',{timeout:180000},async t=>{
  const box=await mainMovedFixture(t,{conflict:true});box.trigger();const terminal=await box.settled();
  assert.equal(terminal.item.item_status,'open',JSON.stringify(terminal.rows));const now=state(box);
  const returned=JSON.parse(now.events.findLast(row=>row.event_kind==='reopen').event_detail);
  assert.deepEqual(returned.conflict.files,['web/feature.js']);assert.equal(returned.conflict.trunk,box.trunk);
  assert.equal(returned.sourceAdvanceReturn.submitted,box.accepted);assert.deepEqual(now.verdicts,box.original.verdicts);
  assert.equal(now.proofs.length,0,'an actual source conflict does not invent or execute a merged proof');
});

test('a named red rerun reopens while an infrastructure guess cannot become acceptance [C7,V4,H16]',{timeout:180000},async t=>{
  const box=await mainMovedFixture(t,{red:true});box.trigger();const terminal=await box.settled();
  assert.equal(terminal.item.item_status,'open',JSON.stringify(terminal.rows));const now=state(box);
  const returned=JSON.parse(now.events.findLast(row=>row.event_kind==='reopen').event_detail);
  assert.equal(returned.sourceAdvanceReturn.outcome,'red');assert.deepEqual(returned.sourceAdvanceReturn.files,['test/check.test.js']);
  assert.match(returned.note,/actual exact composed behavior/u);assert.deepEqual(now.verdicts,box.original.verdicts);
  assert.equal(now.events.filter(row=>row.event_kind==='source_advanced').length,0);
  assert.ok(now.proofs.some(receipt=>receipt.exitCode!==0&&receipt.commit!==box.accepted),'a real red receipt names the attempted composition');
});

test('an unreviewed submission keeps its queue place and still needs an independent verdict [C7,V4,H16]',{timeout:180000},async t=>{
  const box=await mainMovedFixture(t,{submitted:true});box.trigger();const terminal=await box.settled();
  assert.equal(terminal.item.item_status,'submitted',JSON.stringify(terminal.rows));const now=state(box);
  assert.equal(now.item.item_commit,box.accepted);assert.ok(now.item.item_effective_head);assert.equal(now.accepted,undefined);
  assert.equal(now.verdicts.length,0,'the worker never promotes a test pass to an independent review');
});


test('source-advance replay binds native episode, exact receipts and old-engine prefix without caller green [C7,V4,H16]',{timeout:180000},async t=>{
  const box=await mainMovedFixture(t);box.trigger();await box.settled();const now=state(box);
  const engine=await import(pathToFileURL(join(box.installed,'src/engine.js')));
  const {SOURCE_ADVANCE_ENGINE}=await import(pathToFileURL(join(box.installed,'src/source-advance-engine.js')));
  const detail=JSON.parse(now.events.find(row=>row.event_kind==='source_advanced').event_detail);
  const {model,person,...proof}=detail;
  const originalMove={version:1,engine:SOURCE_ADVANCE_ENGINE,id:randomUUID(),operation:'advanceItemSource',args:[box.id,{agentId:'coordinator',proof}]};
  /** Restore genuine pre-advance native history; no runtime result or receipt is synthesized. */
  function replica(name,work) {
    const board=box.store.openBoard(join(box.scratch,`${name}.sqlite`));
    try{importBoard(board,box.original.snapshot);return work(board);}finally{box.store.closeBoard(board);}
  }
  /** Apply the exact source-advance event through the same deterministic receiver as linked boards. */
  function replay(board,move,sequence=1) {return engine.applyEngineMove(board,move,{sequence,at:new Date().toISOString()});}
  replica('valid',board=>{
    const old={version:1,engine:SOURCE_ADVANCE_ENGINE-1,id:randomUUID(),operation:'appendFact',args:[box.id,{agentId:'coordinator',kind:'measurement',text:'historical prefix, no runtime claim'}]};
    const prior=replay(board,old);assert.equal(prior.error,undefined);
    const accepted=replay(board,originalMove,2);assert.equal(accepted.error,undefined);
    const item=box.store.getItem(board,box.id);assert.equal(item.item_commit,box.accepted);assert.equal(item.item_effective_head,now.landing);
    assert.equal(box.store.checkedLandingCommit(board,item),now.landing);assert.equal(box.store.acceptedVerdict(board,item).verdict_id,now.accepted.verdict_id);
    assert.throws(()=>box.store.verify(board,box.id,{agentId:'coordinator',decision:'ACCEPT',head:box.accepted,digest:proof.bar,policy:'any'}),error=>error.code==='SOURCE_ADVANCE_STALE','an older in-flight check cannot borrow the new checked head');
    const after=exportBoard(board);assert.deepEqual(replay(board,old,1),prior,'an exact old receipt retries before new floors');assert.deepEqual(exportBoard(board),after);
    assert.throws(()=>replay(board,{...old,id:randomUUID()},3),error=>error.code==='RELAY_MOVE','a fresh old writer cannot ignore effective source');
    const same=replay(board,{...originalMove,id:randomUUID()},3);assert.equal(same.error,undefined);
    assert.equal(box.store.events(board,{itemId:box.id}).filter(row=>row.event_kind==='source_advanced').length,1,'identical checked completion is idempotent');
    box.store.reopen(board,box.id,{agentId:'coordinator',note:'withdraw original acceptance after the proved merge',withdrawVerdict:true});
    assert.equal(box.store.acceptedVerdict(board,box.store.getItem(board,box.id)),undefined,'source advance cannot resurrect a withdrawn verdict');
    assert.equal(replay(board,{...originalMove,id:randomUUID()},4).error.code,'SOURCE_ADVANCE_STALE','a later episode cannot reuse the earlier green');
  });
  replica('downgrade',board=>{
    assert.throws(()=>replay(board,{...originalMove,engine:SOURCE_ADVANCE_ENGINE-1}),error=>error.code==='RELAY_MOVE');
    assert.equal(box.store.getItem(board,box.id).item_effective_head,undefined);
  });
  replica('tampered-receipt',board=>{
    const changed=structuredClone(originalMove);changed.id=randomUUID();changed.args[1].proof.phases[0].receipt.head=box.accepted;
    assert.equal(replay(board,changed).error.code,'SOURCE_ADVANCE_PROOF');assert.equal(box.store.getItem(board,box.id).item_effective_head,undefined);
  });
  replica('tampered-bar',board=>{
    const changed=structuredClone(originalMove);changed.id=randomUUID();changed.args[1].proof.bar='f'.repeat(64);
    assert.equal(replay(board,changed).error.code,'SOURCE_ADVANCE_STALE');
  });
  replica('changed-patches',board=>{
    box.store.attachItemPatch(board,box.id,{agentId:'coordinator',author:'coordinator',key:'later',commit:box.accepted,
      patch:'diff --git a/web/later.js b/web/later.js\nnew file mode 100644\n--- /dev/null\n+++ b/web/later.js\n@@ -0,0 +1 @@\n+export const later = true;\n'});
    assert.equal(replay(board,originalMove).error.code,'SOURCE_ADVANCE_STALE');
  });
  replica('caller-green',board=>{
    assert.throws(()=>box.store.advanceItemSource(board,box.id,{agentId:'coordinator',proof}),error=>error.code==='SOURCE_ADVANCE_STALE');
    assert.throws(()=>engine.prepareEngineMove(board,'advanceItemSource',[box.id,{agentId:'coordinator',proof}]),error=>error.code==='SOURCE_ADVANCE_STALE');
    assert.equal(box.store.getItem(board,box.id).item_effective_head,undefined,'even genuine copied receipt bytes cannot replace origin custody');
  });
});
