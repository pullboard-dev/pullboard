/** @pullboard-test-input packages/landing/index.js packages/state/index.js packages/state/src/logic/engines/source-advance-engine.js */
/** @pullboard-test-loads packages/state/src/io/engine.js packages/state/src/logic/engines/source-advance-engine.js packages/landing/index.js */
/** A main move returns a red or unreviewed source to its builder and never endorses dirty evidence [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { mainMovedFixture } from '../../../tests/fixtures/main/moved.js';

/** Read the native checked source and immutable receipts after the independent worker has drained. */
function state(box) { return box.board(board=>({item:box.store.getItem(board,box.id),verdicts:box.store.verdictsFor(board,box.id),
  accepted:box.store.acceptedVerdict(board,box.store.getItem(board,box.id)),events:box.store.events(board,{itemId:box.id}),
  landing:box.store.checkedLandingCommit(board,box.store.getItem(board,box.id)),proofs:box.store.proofReceipts(board,box.id)})); }

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

/** Dirty candidate output is observed before cleanup and cannot masquerade as source-clean evidence. */
test('an admitted dirty child retains raw evidence without endorsement and removes its owned checkout [C7,V4,H16]',{timeout:180000},async t=>{
  const box=await mainMovedFixture(t,{dirty:true});box.trigger();const terminal=await box.settled();const now=state(box);
  assert.equal(terminal.item.item_status,'verified',JSON.stringify(terminal.rows));
  assert.equal(now.item.item_effective_head,undefined);assert.deepEqual(now.verdicts,box.original.verdicts);
  assert.equal(now.events.filter(row=>row.event_kind==='source_advanced').length,0);
  const job=terminal.rows.find(row=>row.state==='incomplete');assert.ok(job,JSON.stringify(terminal.rows));
  const manifests=readdirSync(box.directory,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>JSON.parse(readFileSync(join(box.directory,entry.name,'manifest.json'),'utf8')));
  assert.equal(manifests.length,1);assert.ok(manifests[0].artifacts.length>0,'raw evidence survives independently of the removed checkout');
  for(const artifact of manifests[0].artifacts)assert.equal(createHash('sha256').update(readFileSync(artifact.file)).digest('hex'),artifact.sha256);
  assert.ok(manifests[0].artifacts.some(artifact=>artifact.file.endsWith('.log')&&readFileSync(artifact.file,'utf8').includes('actual exact composed behavior')));
  assert.ok(!box.git(box.repo,'worktree','list','--porcelain').includes('pullboard-source-advance-'),'known returned child output does not strand a registered private checkout');
});
