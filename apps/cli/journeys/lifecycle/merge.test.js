/** @pullboard-test-input docs/lifecycle.md packages/landing/index.js packages/state/index.js packages/state/src/logic/engines/source-advance-engine.js */
/** @pullboard-test-loads packages/state/src/io/engine.js packages/state/src/logic/engines/source-advance-engine.js packages/landing/index.js */
/** Actual automatic main movement retains assurance only after real nondeferred checks [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { test } from 'node:test';
import { selectAffectedTests } from '../../../../packages/gate/index.js';
import { mainMovedFixture } from '../../tests/fixtures/main/moved.js';

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
  const engine=await import(pathToFileURL(join(box.installed,'packages/state/index.js')));
  const {SOURCE_ADVANCE_ENGINE}=await import(pathToFileURL(join(box.installed,'packages/state/src/logic/engines/source-advance-engine.js')));
  const detail=JSON.parse(now.events.find(row=>row.event_kind==='source_advanced').event_detail);
  const {model,person,...proof}=detail;
  const originalMove={version:1,engine:SOURCE_ADVANCE_ENGINE,id:randomUUID(),operation:'advanceItemSource',args:[box.id,{agentId:'coordinator',proof}]};
  /** Restore genuine pre-advance native history; no runtime result or receipt is synthesized. */
  function replica(name,work) {
    /** @pullboard-board-file journey: replay the actual native source-advance event into an independent receiver. */
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
    assert.throws(()=>board.enginePorts.store.advanceItemSource(board,box.id,{agentId:'coordinator',proof}),error=>error.code==='SOURCE_ADVANCE_STALE');
    assert.throws(()=>engine.prepareEngineMove(board,'advanceItemSource',[box.id,{agentId:'coordinator',proof}]),error=>error.code==='SOURCE_ADVANCE_STALE');
    assert.equal(box.store.getItem(board,box.id).item_effective_head,undefined,'even genuine copied receipt bytes cannot replace origin custody');
  });
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

/** Wait only for an actual private marker or native queue state, with a bounded failure diagnostic. */
async function observeCompletion(predicate, message) {
  const until = Date.now() + 30000;
  while (!predicate()) {
    assert.ok(Date.now() < until, message);
    await pause(10);
  }
}

for (const red of [false, true]) test(`an in-flight ${red ? 'red return' : 'green advance'} waits for the actual landing owner [C7,V4,H16]`, { timeout: 180000 }, async t => {
  const box = await mainMovedFixture(t, { blocked: true, red });
  box.trigger();
  await observeCompletion(() => existsSync(box.gateEntered), 'the actual source-advance test body starts');
  const { takeLandingResource } = await import(pathToFileURL(join(box.installed, 'packages/landing/index.js')));
  // @pullboard-board-file journey: hold a real private landing lease while the separate source worker completes its real gate.
  const board = box.store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { isMain: true });
  let lease;
  try {
    lease = await takeLandingResource({ board, branch: 'refs/heads/main',
      write: async (operation, args) => box.store[operation](board, ...args) });
    writeFileSync(box.gateRelease, 'released');
    await observeCompletion(() => box.store.landingLeaseState(board).line.length > 0
      || box.store.events(board, { itemId: box.id }).some(row => ['source_advanced', 'reopen'].includes(row.event_kind)),
      'the finished source check queues or exposes an actual raced native mutation');
    assert.ok(box.store.landingLeaseState(board).line.length > 0, 'completion must queue instead of racing the held landing');
    const waiting = state(box);
    assert.equal(waiting.item.item_status, 'verified');
    assert.equal(waiting.item.item_commit, box.accepted);
    assert.equal(waiting.landing, box.accepted, 'no measured source substitutes for the held checked composition');
    assert.deepEqual(waiting.verdicts, box.original.verdicts);
    assert.equal(waiting.events.filter(row => ['source_advanced', 'reopen'].includes(row.event_kind)).length, 0);
    const rows = readdirSync(box.directory).filter(name => /^[a-f0-9]{64}$/u.test(name));
    assert.equal(rows.length, 1, 'the actual completed gate artifacts exist before completion admission');
    const manifest = JSON.parse(readFileSync(join(box.directory, rows[0], 'manifest.json'), 'utf8'));
    assert.ok(manifest.artifacts.some(row => row.roles.includes('criterion')));
    if (!red) assert.ok(manifest.artifacts.some(row => row.roles.includes('affected')), 'both real green phases completed before waiting');
    await lease.release(); lease = null;
    const terminal = await box.settled();
    const now = state(box);
    assert.equal(terminal.item.item_status, red ? 'open' : 'verified', JSON.stringify(terminal.rows));
    assert.equal(now.events.filter(row => row.event_kind === (red ? 'reopen' : 'source_advanced')).length, 1);
    assert.deepEqual(now.verdicts, box.original.verdicts);
    if (!red) assert.notEqual(now.landing, box.accepted);
  } finally {
    writeFileSync(box.gateRelease, 'released');
    if (lease) await lease.release();
    box.store.closeBoard(board);
    await box.settled();
  }
});
