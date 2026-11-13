/** @pullboard-test-input packages/landing/index.js packages/state/index.js packages/state/src/logic/engines/source-advance-engine.js */
/** @pullboard-test-loads packages/state/src/io/engine.js packages/state/src/logic/engines/source-advance-engine.js packages/landing/index.js */
/** Actual automatic main movement retains assurance only after real nondeferred checks [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mainMovedFixture } from '../../../tests/fixtures/main/moved.js';

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
  const artifacts=terminal.rows.flatMap(row=>row.artifacts ?? []);
  for(const role of ['criterion','affected']) {
    const phase=artifacts.filter(row=>row.roles.includes(role));assert.equal(phase.length,1);
    const output=readFileSync(phase[0].file,'utf8');
    assert.equal(createHash('sha256').update(output).digest('hex'),phase[0].sha256);
    t.diagnostic(JSON.stringify({phase:role,output,proofCounts:now.proofs.map(row=>row.counts)}));
    assert.equal(output.split('SOURCE_ADVANCE_BODY').length-1,1,`${role} retains exactly one actual executed body`);
    assert.match(output,/ok 1 - actual exact composed behavior/u);
  }
  assert.ok(now.proofs.every(row=>row.counts.passed===1&&row.counts.failed===0&&row.counts.skipped===0));
  t.diagnostic(JSON.stringify({sourceAdvanceHead:now.landing,phaseExecutors:now.proofs.map(row=>({id:row.id,environment:row.environment,testRuntimes:row.testRuntimes,runner:row.runner})),artifacts}));
  const before=box.board(board=>box.store.events(board).length);box.trigger();const repeated=await box.settled();
  assert.equal(box.board(board=>box.store.events(board).filter(row=>row.event_kind==='source_advanced').length),1);
  assert.deepEqual(repeated.rows.flatMap(row=>row.artifacts ?? []),artifacts,'an unchanged wake preserves the exact prior real phase artifacts');
  assert.equal(state(box).proofs.length,2,'an unchanged wake creates no replacement execution receipt');
  assert.ok(box.board(board=>box.store.events(board).length)>=before);
});

test('a real source conflict reopens the same item with its exact file and leaves the verdict immutable [C7,V4,H16]',{timeout:180000},async t=>{
  // Keep the independently scheduled automatic lander from returning this item before the source worker.
  const box=await mainMovedFixture(t,{conflict:true,manualLanding:true});box.trigger();const terminal=await box.settled();
  assert.equal(terminal.item.item_status,'open',JSON.stringify(terminal.rows));const now=state(box);
  const returned=JSON.parse(now.events.findLast(row=>row.event_kind==='reopen').event_detail);
  assert.deepEqual(returned.conflict.files,['web/feature.js']);assert.equal(returned.conflict.trunk,box.trunk);
  assert.ok(returned.sourceAdvanceReturn, `source advance return missing from reopen: ${JSON.stringify(returned)}`);
  assert.equal(returned.sourceAdvanceReturn.submitted,box.accepted);assert.deepEqual(now.verdicts,box.original.verdicts);
  assert.equal(now.proofs.length,0,'an actual source conflict does not invent or execute a merged proof');
  const history = box.board(board => box.store.events(board));
  const returnedAt = history.findIndex(row => row.event_kind === 'reopen' && row.item_id === box.id);
  assert.ok(history.slice(0, returnedAt).some(row => row.event_kind === 'landing_lease' && JSON.parse(row.event_detail).action === 'request'), 'the conflict return takes the same actual completion lease');
  assert.ok(history.slice(returnedAt + 1).some(row => row.event_kind === 'landing_lease' && JSON.parse(row.event_detail).action === 'release'), 'the conflict return releases only after its ordered mutation');
});
