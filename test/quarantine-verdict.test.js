/** Structured native quarantine keeps actual red results and counts only executed identities [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyPackageFiles } from '../src/package-files.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { commitFixtureFiles } from './package-copy-fixture.js';
import { runFixtureChildAsync } from './fixture-child.js';

const TARGET = 'actual quarantine target [C7]';
const FILE = 'test/control.test.js';

/** Commit a complete installed runtime and one private test universe through ordinary fixture hooks. */
function quarantineProject(t, { legacy = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project(`node bin/run-tests.js ${FILE}`, helpers.sandbox(), { withWorktree: false });
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const copied = copyPackageFiles(join(import.meta.dirname, '..'), box.repo);
  // The complete installed runtime is real; its own shipped tests are outside this synthetic test universe.
  for (const file of copied) if (file !== 'package.json' && !/^(?:src|bin|packages)\//u.test(file)) rmSync(join(box.repo, file), { force: true });
  for (const file of copied) if (/\.test\.[cm]?js$/u.test(file)) rmSync(join(box.repo, file), { force: true });
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, flakes: { rerun: false, quarantine: true },
    lanes: { web: { owns: ['test/'], specs: [] } },
    ...(legacy ? { gate: `node --test --test-reporter=tap ${FILE}` } : {}) }) + '\n');
  writeFileSync(join(box.repo, 'SPEC.md'), spec);
  writeFileSync(join(box.repo, FILE), `import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
const mode=process.env.PULLBOARD_QUARANTINE_CASE_MODE;
if(!['unrelated','suite'].includes(mode))test(${JSON.stringify(TARGET)},{skip:mode==='skip',todo:mode==='todo'},()=>assert.ok(!['red','mixed'].includes(mode)));
if(mode==='suite')describe('unrelated suite [C7]',()=>test('suite child [C7]',()=>assert.equal(3+3,6)));
test('unrelated positive [C7]',()=>assert.notEqual(mode,'mixed'));\n`);
  writeFileSync(join(box.repo, 'quarantine-driver.mjs'), DRIVER);
  commitFixtureFiles(box, box.git(box.repo, 'ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard').split('\0').filter(Boolean));
  const env = { ...box.env, PULLBOARD_TEST_REUSE: '0' };
  delete env.NODE_TEST_CONTEXT;
  return { ...box, env };
}

// The installed private program executes real red/green children and canonical ordered receipt moves.
const DRIVER = `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {git} from './src/git.js';
import {runGate,runProfiledShell,withGateSlot} from './src/gate.js';
import {receiptRecorder} from './src/native-flake-receipts.js';
import {context,ordered,withBoard,resourceAgent,freezer} from './src/cli.js';
import {runnerExecutionServices} from './src/runners.js';
import {landingExecutionServices} from './src/landing-shards.js';
import {readGateReceipt,receiptStore,receiptBody,receiptFields} from './src/gate-run-receipt.js';
import {prepareEngineMove,applyEngineMove,appliedSequence} from './src/engine.js';
import {QUARANTINE_VERDICT_ENGINE} from './src/quarantine-verdict-engine.js';
import {quarantineVerdictSnapshot,validateQuarantineVerdict,validateQuarantineGate,recordGateRun} from './src/quarantine.js';
import {receiptBlockingGreen,nativeProofBlockingGreen} from './src/quarantine-verdict.js';
import {proofRunReceipt} from './src/proof-receipts.js';
import {checkTrainLandingReceipt,readTrainLandingReceipt} from './src/train-landing-receipt.js';
import {runLocalLandingGuard} from './src/land-local-guard.js';
import {runDeferredAffectedTests} from './src/landing-deferred-run.js';
import {sourceAdvanceProblem} from './src/source-advance.js';
import {sourceAdvanceEpisode,sourceAdvanceReviewEpisode} from './src/source-advance-state.js';
import {itemPatchDigest} from './src/item-patch-state.js';
import {proofCounts} from './src/proof-provenance.js';
import * as store from './src/board.js';
const root=process.cwd(),config=JSON.parse(readFileSync('pullboard.json','utf8'));
const ctx=context({cwd:root,say(){},err(){}}),agentId=resourceAgent(ctx);
const observer=Object.assign(async()=>{}, {recordRun:receiptRecorder(ctx,{agentId,acceptedConfig:config,ordered,withBoard})});
const executionServices={runners:runnerExecutionServices(),landing:landingExecutionServices()};
const snapshot=()=>withBoard(ctx,quarantineVerdictSnapshot);
async function gate(mode,quarantines=[]){
 process.env.PULLBOARD_QUARANTINE_CASE_MODE=mode;
 return runGate(root,config,{trustStamp:false,agent:agentId,onFailure:observer,executionServices,quarantines});
}
const red=await gate('red'),green=await gate('green');
assert.equal(red.isGreen,false);assert.equal(green.isGreen,true);
const quarantines=snapshot();assert.equal(quarantines.length,1);
await withBoard(ctx,board=>ordered(ctx,board,'refreeze',[quarantines[0].item,{agentId,freeze:freezer(ctx,{board})}]));
const item=withBoard(ctx,board=>store.getItem(board,quarantines[0].item));
const proofContext={item:item.item_id,frozenDigest:item.item_frozen_digest,seat:agentId,kind:'submit'};
const only=await gate('red',quarantines);
assert.equal(only.isGreen,true,only.output);assert.equal(only.exitCode,1);
const receipt=readGateReceipt(receiptStore(root),only.receiptId);
assert.equal(receipt.green,false);assert.equal(receiptBlockingGreen(receipt),true);
assert.equal(proofCounts(only.output).failed,1);
assert.match(only.output,/actual quarantine target/);
assert.deepEqual(receipt.blockingVerdict.quarantines,quarantines);
const gateRecord={...only,tree:receipt.tree};
withBoard(ctx,board=>validateQuarantineGate(board,gateRecord));
withBoard(ctx,board=>assert.throws(()=>validateQuarantineGate(board,{...gateRecord,isGreen:false}),error=>error.code==='PROOF_RUN_UNBOUND'));
const mixed=await gate('mixed',quarantines);
assert.equal(mixed.exitCode,1);assert.equal(mixed.isGreen,false,'a second unquarantined case still blocks');
assert.equal(mixed.blockingVerdict.green,false);
assert.equal(readGateReceipt(receiptStore(root),mixed.receiptId).failures.length,2);
const exit2=await runGate(root,{...config,gate:config.gate+'; exit 2'},
 {trustStamp:false,agent:agentId,onFailure:observer,executionServices,quarantines});
assert.equal(exit2.isGreen,false);assert.equal(exit2.exitCode,2);assert.equal(exit2.blockingVerdict,undefined);
process.env.PULLBOARD_QUARANTINE_CASE_MODE='red';
const native=await withGateSlot(root,lease=>{
 lease.quarantines=quarantines;lease.proof=proofContext;
 return runProfiledShell(root,config.gate,{gateLease:lease,stages:true});
},{executionServices,agent:agentId,kind:'check'});
assert.equal(native.isGreen,true);assert.equal(native.exitCode,1);
const nativeReceipt=readGateReceipt(receiptStore(root),native.proofReceiptId);
assert.equal(nativeReceipt.proof.exitCode,1);assert.equal(nativeReceipt.green,false);
assert.equal(nativeReceipt.proof.counts.failed,1);assert.equal(receiptBlockingGreen(nativeReceipt),true);
let nativeBoardReceipt;
await withBoard(ctx,async board=>{
 nativeBoardReceipt=await ordered(ctx,board,'recordProofRun',[{agentId,itemId:item.item_id,receiptId:native.proofReceiptId}]);
 const again=await ordered(ctx,board,'recordProofRun',[{agentId,itemId:item.item_id,receiptId:native.proofReceiptId}]);
 assert.equal(again.id,nativeBoardReceipt.id);
 const move=prepareEngineMove(board,'recordProofRun',[{agentId,itemId:item.item_id,receiptId:native.proofReceiptId}]);
 assert.ok(move.engine>=QUARANTINE_VERDICT_ENGINE);
 const sequence=appliedSequence(board)+1;
 assert.throws(()=>applyEngineMove(board,{...move,id:'old-quarantine-floor',engine:QUARANTINE_VERDICT_ENGINE-1},
 {sequence,at:new Date().toISOString()}),error=>error.code==='RELAY_MOVE');
 assert.equal(appliedSequence(board),sequence-1);
});
assert.equal(nativeBoardReceipt.exitCode,1);assert.equal(nativeProofBlockingGreen(nativeBoardReceipt),true);
// The source-advance reader consumes actual native receipt bytes; CAS identities are fixture inputs, not proof.
withBoard(ctx,board=>{
 const current=store.getItem(board,item.item_id);
 const candidate={...current,item_status:'submitted',item_commit:git(root,['rev-parse','HEAD^']),item_merged_commit:null};
 const proof={version:1,board:board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value,
 submitted:candidate.item_commit,status:'submitted',bar:candidate.item_frozen_digest,
 reviewEpisode:sourceAdvanceReviewEpisode(board,candidate.item_id),reviewBy:candidate.item_review_by,reviewUntil:candidate.item_review_until,
 patchDigest:itemPatchDigest(board,candidate.item_id),episode:sourceAdvanceEpisode(board,candidate.item_id),verdict:null,
 previous:candidate.item_commit,inputHead:candidate.item_commit,head:nativeReceipt.head,tree:nativeReceipt.tree,trunk:nativeReceipt.main,
 mergeTree:nativeReceipt.tree,selectionDigest:'a'.repeat(64),paths:[],phases:[{role:'affected',command:nativeReceipt.command,receipt:nativeReceipt}]};
 assert.equal(sourceAdvanceProblem(board,candidate,proof),null,'the actual raw-exit-one receipt is accepted by source advance');
 const raw=structuredClone(nativeReceipt);delete raw.blockingVerdict;
 assert.equal(sourceAdvanceProblem(board,candidate,{...proof,phases:[{...proof.phases[0],receipt:raw}]}).code,'SOURCE_ADVANCE_PROOF');
});
const land=await runGate(root,config,{trustStamp:false,landing:true,agent:agentId,quarantines,onFailure:observer,executionServices});
assert.equal(land.isGreen,true);assert.equal(land.exitCode,1);
const landReceipt=readGateReceipt(receiptStore(root),land.receiptId);
assert.equal(checkTrainLandingReceipt(landReceipt,landReceipt.head).green,false);
withBoard(ctx,board=>assert.equal(readTrainLandingReceipt(root,board,landReceipt.id,landReceipt.head).id,landReceipt.id));
const guards=await runLocalLandingGuard(root,config,{files:['test/control.test.js'],directory:root+'/../logs',label:'guard',onFailure:observer,
 quarantines,proofContext:{...proofContext,kind:'land'}});
assert.equal(guards.isGreen,true);assert.equal(guards.exitCode,1);
assert.ok(guards.proofReceiptId,'a selective landing exception keeps its own actual native receipt');
const deferred=await runDeferredAffectedTests(root,{...config,affectedTests:'node bin/run-tests.js'},['test/control.test.js'],
 {directory:root+'/../logs',quarantines,proofContext:{...proofContext,kind:'land'}});
assert.equal(deferred.isGreen,true);assert.equal(deferred.exitCode,1);assert.ok(deferred.proofReceiptId);
const unchanged=receiptBody(nativeReceipt);
assert.equal(receiptFields({...nativeReceipt,blockingVerdict:null}),null);
assert.equal(receiptFields({...nativeReceipt,proof:{...nativeReceipt.proof,exitCode:0}}),null);
const foreign=structuredClone(nativeReceipt);foreign.blockingVerdict.quarantines[0].eventId++;
withBoard(ctx,board=>assert.throws(()=>validateQuarantineVerdict(board,foreign),error=>error.code==='PROOF_RUN_UNBOUND'));
const legacy=readGateReceipt(receiptStore(root),red.receiptId);
assert.equal(Object.hasOwn(legacy,'blockingVerdict'),false);
assert.equal(receiptBody(receiptFields(JSON.parse(receiptBody(legacy)))),receiptBody(legacy));
// Twenty genuinely executed passes close this exact quarantine. A cached exception then loses authority.
for(let index=0;index<20;index++)await gate('green');
assert.deepEqual(snapshot(),[]);
withBoard(ctx,board=>{
 assert.throws(()=>validateQuarantineVerdict(board,nativeReceipt),error=>error.code==='PROOF_RUN_UNBOUND');
 assert.throws(()=>validateQuarantineGate(board,gateRecord),error=>error.code==='PROOF_RUN_UNBOUND');
 validateQuarantineGate(board,gateRecord,{historical:true});
 assert.equal(recordGateRun(board,{agentId,receipt,lane:'web'}).duplicate,true,'the original immutable event remains idempotent after closure');
 assert.equal(proofRunReceipt(board,{agentId,itemId:item.item_id,receiptId:native.proofReceiptId}).existing.id,nativeReceipt.id);
});
assert.equal(receiptBody(readGateReceipt(receiptStore(root),nativeReceipt.id)),unchanged);
console.log(JSON.stringify({actualGate:true,nativeProof:true,sourceAdvance:true,landing:true,rawExit:1,closed:true}));
`;

test('every native quarantine verdict reader retains real raw red and rejects uncovered or expired authority [C7,H16]', async t => {
  const box = quarantineProject(t);
  const result = await runFixtureChildAsync(process.execPath, ['quarantine-driver.mjs'], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(report, { actualGate: true, nativeProof: true, sourceAdvance: true, landing: true, rawExit: 1, closed: true });
});
