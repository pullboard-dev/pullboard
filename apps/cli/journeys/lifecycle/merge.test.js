/** @pullboard-test-input packages/landing/index.js packages/state/index.js packages/state/src/logic/engines/source-advance-engine.js */
/** @pullboard-test-loads packages/state/src/io/engine.js packages/state/src/logic/engines/source-advance-engine.js packages/landing/index.js */
/** Source-advance replay binds genuine native evidence, and an in-flight advance waits for the landing owner [C7,V4,H16]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { test } from 'node:test';
import { mainMovedFixture } from '../../tests/fixtures/main/moved.js';

/** Read the native checked source and immutable receipts after the independent worker has drained. */
function state(box) { return box.board(board=>({item:box.store.getItem(board,box.id),verdicts:box.store.verdictsFor(board,box.id),
  accepted:box.store.acceptedVerdict(board,box.store.getItem(board,box.id)),events:box.store.events(board,{itemId:box.id}),
  landing:box.store.checkedLandingCommit(board,box.store.getItem(board,box.id)),proofs:box.store.proofReceipts(board,box.id)})); }

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

/** Wait only for an actual private marker or native queue state, with a bounded failure diagnostic. */
async function observeCompletion(predicate, message) {
  const until = Date.now() + 30000;
  while (!predicate()) {
    assert.ok(Date.now() < until, message);
    await pause(10);
  }
}
