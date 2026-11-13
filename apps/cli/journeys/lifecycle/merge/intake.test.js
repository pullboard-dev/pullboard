/** @pullboard-test-input packages/landing/index.js packages/state/index.js packages/state/src/logic/engines/source-advance-engine.js */
/** @pullboard-test-loads packages/state/src/io/engine.js packages/state/src/logic/engines/source-advance-engine.js packages/landing/index.js */
/** Outside intake is never composed by the main worker, and selective checks cover only the changed closure [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { selectAffectedTests } from '../../../../../packages/gate/index.js';
import { mainMovedFixture } from '../../../tests/fixtures/main/moved.js';

/** Read the native checked source and immutable receipts after the independent worker has drained. */
function state(box) { return box.board(board=>({item:box.store.getItem(board,box.id),verdicts:box.store.verdictsFor(board,box.id),
  accepted:box.store.acceptedVerdict(board,box.store.getItem(board,box.id)),events:box.store.events(board,{itemId:box.id}),
  landing:box.store.checkedLandingCommit(board,box.store.getItem(board,box.id)),proofs:box.store.proofReceipts(board,box.id)})); }

/** Outside intake is a real native transition; only its isolated reviewer may execute the source. */
test('an outside submitted source is never composed or checked by the native main worker [C7,V4,H16]',{timeout:180000},async t=>{
  const box=await mainMovedFixture(t,{outside:true});
  const before=box.board(board=>({item:box.store.getItem(board,box.id),events:box.store.events(board,{itemId:box.id})}));
  assert.equal(before.item.outside.kind,'pull-request');
  assert.ok(before.events.some(row=>row.event_kind==='outside-intake'),'the source came through the actual native intake transition');
  const worktrees=box.git(box.repo,'worktree','list','--porcelain');
  box.trigger();const terminal=await box.settled();const now=state(box);
  assert.equal(now.item.item_status,'submitted');assert.equal(now.item.item_commit,box.accepted);
  assert.equal(now.item.item_effective_head,undefined);assert.deepEqual(now.verdicts,[]);assert.deepEqual(now.proofs,[]);
  assert.equal(now.events.some(row=>['source_advanced','reopen'].includes(row.event_kind)),false);
  assert.equal(terminal.rows.length,1);assert.equal(terminal.rows[0].state,'incomplete');
  assert.deepEqual(Object.keys(terminal.rows[0].basis),['trunk'],'refusal precedes capture of an executable composition basis');
  assert.match(terminal.rows[0].reason,/OUTSIDE_SANDBOX_REQUIRED|outside sources retain their isolated sandbox path/u);
  assert.equal(terminal.rows.flatMap(row=>row.artifacts??[]).length,0,'no native test phase produced execution artifacts');
  assert.equal(box.git(box.repo,'worktree','list','--porcelain'),worktrees,'outside source never acquired a composition checkout');
  assert.equal(box.git(box.repo,'status','--porcelain'),'');
  box.trigger();const repeated=await box.settled();assert.deepEqual(repeated.rows,terminal.rows,'the unavailable sandbox path is not hot-retried');
});

/** A minimal consumer project keeps selective execution distinct from the full installed-tooling fallback. */
test('source advance selectively checks only the changed project closure [C7,V4,H16]',{timeout:180000},async t=>{
  const box=await mainMovedFixture(t,{selective:true});box.trigger();const terminal=await box.settled();
  assert.equal(terminal.item.item_status,'verified',JSON.stringify(terminal.rows));
  const now=state(box);
  const selection=selectAffectedTests(box.repo,{base:box.accepted,commit:now.landing});
  assert.equal(selection.full,false,selection.reason);
  assert.deepEqual(selection.files,['test/check.test.js']);
  assert.equal(now.proofs.length,2);
  assert.ok(now.proofs.every(row=>row.commit===now.landing&&row.exitCode===0&&row.sourceClean&&row.counts.passed===1&&row.counts.failed===0&&row.counts.skipped===0));
  const detail=JSON.parse(now.events.find(row=>row.event_kind==='source_advanced').event_detail);
  const command="node --test --test-reporter=tap './test/check.test.js'";
  assert.equal(detail.phases.find(phase=>phase.role==='affected').command,createHash('sha256').update(command).digest('hex'));
  for(const artifact of terminal.rows.flatMap(row=>row.artifacts??[]).filter(row=>row.roles.includes('criterion')||row.roles.includes('affected'))){
    const output=readFileSync(artifact.file,'utf8');
    assert.equal(output.split('SOURCE_ADVANCE_BODY').length-1,1);
    assert.ok(!output.includes('UNRELATED_BODY'));
  }
});
