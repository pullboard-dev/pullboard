import { landingWaiverProjection } from '../../../../../packages/landing/index.js';
import { landingFailureWaived } from '../../../../../packages/landing/index.js';
/** Structured native quarantine keeps actual red results and counts only executed identities [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import {
  commitFixtureFiles,
  copyCommittedPackageFiles,
} from '../../../tests/fixtures/copy.js';
import { runFixtureChildAsync } from '../../../tests/fixtures/child.js';

const TARGET = 'actual quarantine target [C7]';
const FILE = 'test/control.test.js';

/** Commit a complete installed runtime and one private test universe through ordinary fixture hooks. */
function quarantineProject(t, { legacy = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project(`node tooling/packages/gate/src/io/run/tests.js ${FILE}`, helpers.sandbox(), { withWorktree: false });
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  // Shipped code is a committed tooling dependency; the private project root remains the test universe.
  copyCommittedPackageFiles(box, join(import.meta.dirname, '../../../../..'), { directory: 'tooling' });
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...config, flakes: { rerun: false, quarantine: true },
    lanes: { web: { owns: ['test/'], specs: [] } },
    gate: legacy ? `node --test --test-reporter=tap ${FILE}` : `node tooling/packages/gate/src/io/run/tests.js ${FILE}` }) + '\n');
  writeFileSync(join(box.repo, 'SPEC.md'), spec);
  writeFileSync(join(box.repo, FILE), `import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
const mode=process.env.PULLBOARD_QUARANTINE_CASE_MODE;
if(!['unrelated','suite'].includes(mode))describe('native aggregate [C7]',()=>test(${JSON.stringify(TARGET)},{skip:mode==='skip',todo:mode==='todo'},()=>assert.ok(!['red','mixed'].includes(mode))));
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
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {prepareItemPatchSubmit,withItemPatchSubmit} from './tooling/packages/items/index.js';
import {submitGateConfig} from './tooling/packages/gate/index.js';
import {policyAt} from './tooling/packages/sandbox/index.js';
import {git} from './tooling/packages/git/index.js';
import {runGate,runProfiledShell,runFrozenProof,runSubmitGate,withGateSlot} from './tooling/packages/gate/index.js';
import {receiptRecorder} from './tooling/packages/flakes/index.js';
import {context,cli$ordered as ordered,withBoard,resourceAgent,cli$freezer as freezer,queuedItemLease} from './tooling/apps/cli/index.js';
import {runnerExecutionServices} from './tooling/packages/runners/index.js';
import {landingExecutionServices} from './tooling/packages/landing/index.js';
import {readGateReceipt,receiptStore,receiptBody,receiptFields} from './tooling/packages/gate/index.js';
import {prepareEngineMove,applyEngineMove,appliedSequence} from './tooling/packages/state/index.js';
import {QUARANTINE_VERDICT_ENGINE} from './tooling/packages/state/src/logic/engines/quarantine-verdict-engine.js';
import {quarantineVerdictSnapshot,flakeQuarantines,validateQuarantineVerdict,validateQuarantineGate,recordGateRun,quarantineWaivers,validateQuarantineProofIds,validateQuarantineLandingProof} from './tooling/packages/flakes/index.js';
import {receiptBlockingGreen,nativeProofBlockingGreen,blockingFailures} from './tooling/packages/verify/index.js';
import {proofRunReceipt} from './tooling/packages/store/index.js';
import {submit as submitMove,verify as verifyMove,finishLandingBatch as finishMove} from './tooling/packages/moves/index.js';
import {checkTrainLandingReceipt,readTrainLandingReceipt} from './tooling/packages/landing/index.js';
import {runLocalLandingGuard} from './tooling/packages/landing/index.js';
import {gateGroup} from './tooling/packages/landing/index.js';
import {flakeSource,observeNativeFailure} from './tooling/packages/flakes/index.js';
import {runDeferredAffectedTests} from './tooling/packages/landing/index.js';
import {sourceAdvanceProblem} from './tooling/packages/sandbox/index.js';
import {sourceAdvanceEpisode,sourceAdvanceReviewEpisode} from './tooling/packages/verify/index.js';
import {itemPatchDigest} from './tooling/packages/items/index.js';
import {proofCounts} from './tooling/packages/verify/index.js';
import {failureSignatures,MAIN_FAILURE_SIGNATURE_VERSION} from './tooling/packages/landing/index.js';
import {fullGateRun,recordRun} from './tooling/packages/gate/index.js';
import {accountedFailures} from './tooling/packages/landing/index.js';
import {checkAtCommit} from './tooling/apps/runner/index.js';
import * as store from './tooling/packages/store/index.js';
import * as nativeBoard from './tooling/apps/lib/index.js';
const root=process.cwd(),config=JSON.parse(readFileSync('pullboard.json','utf8'));
const io={cwd:root,nativeBoard,say(){},err(){},gateWaitReporter:()=>()=>{}};
const ctx=context(io),agentId=resourceAgent(ctx);
const observer=Object.assign(async()=>{}, {recordRun:receiptRecorder(ctx,{agentId,acceptedConfig:config,ordered,withBoard})});
const executionServices={runners:runnerExecutionServices(),landing:landingExecutionServices()};
const snapshot=()=>withBoard(ctx,quarantineVerdictSnapshot);
async function gate(mode,quarantines=[]){
 process.env.PULLBOARD_QUARANTINE_CASE_MODE=mode;
 if(mode==='mixed')return withGateSlot(root,async lease=>{
  lease.quarantines=quarantines;lease.signatureCapture={version:MAIN_FAILURE_SIGNATURE_VERSION,derive:(run,root)=>failureSignatures(run,root,{raw:true})};
  const result=fullGateRun(root,config,false,{gateLease:lease,stages:true});await recordRun(observer,result);return result;
 },{executionServices,agent:agentId,kind:'gate'});
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
assert.equal(accountedFailures(mixed,root),null,'the old raw waiver parser remains strict about aggregate TAP');
assert.deepEqual(blockingFailures(mixed,accountedFailures(mixed,root)).map(row=>row.name),['unrelated positive [C7]']);
assert.deepEqual(failureSignatures(mixed,root).map(row=>row.name),['unrelated positive [C7]'],'known-main diagnostics retain only the uncovered actual case');
const mixedReceipt=readGateReceipt(receiptStore(root),mixed.receiptId);
assert.equal(mixedReceipt.failures.length,2);
assert.equal(mixedReceipt.failureSignatures.failures.length,2,'native receipt retains both raw failures, including quarantine');
assert.deepEqual(blockingFailures(mixedReceipt,mixedReceipt.failureSignatures.failures).map(row=>row.name),['unrelated positive [C7]'],'only authenticated uncovered signatures remain for automatic Main red ownership');
withBoard(ctx,board=>validateQuarantineVerdict(board,mixedReceipt));
const exit2=await runGate(root,{...config,gate:config.gate+'; exit 2'},
 {trustStamp:false,agent:agentId,onFailure:observer,executionServices,quarantines});
assert.equal(exit2.isGreen,false);assert.equal(exit2.exitCode,2);assert.equal(exit2.blockingVerdict,undefined);
process.env.PULLBOARD_QUARANTINE_CASE_MODE='red';
const native=await withGateSlot(root,lease=>{
 lease.quarantines=quarantines;lease.proof=proofContext;
 lease.signatureCapture={version:MAIN_FAILURE_SIGNATURE_VERSION,derive:(run,root)=>failureSignatures(run,root,{raw:true})};
 return runProfiledShell(root,config.gate,{gateLease:lease,stages:true});
},{executionServices,agent:agentId,kind:'check'});
assert.equal(native.isGreen,true);assert.equal(native.exitCode,1);
const nativeReceipt=readGateReceipt(receiptStore(root),native.proofReceiptId);
assert.equal(nativeReceipt.failureSignatures.failures.length,1,'version2 retains the full raw quarantined failure too');
assert.equal(nativeReceipt.proof.exitCode,1);assert.equal(nativeReceipt.green,false);
assert.equal(nativeReceipt.proof.counts.failed,1);assert.equal(receiptBlockingGreen(nativeReceipt),true);
// Missing proving custody never creates a new native proof event, even while its event refs remain current.
withBoard(ctx,board=>{
 const entry=flakeQuarantines(board).find(row=>row.eventId===quarantines[0].eventId);
 const proving=receiptStore(root)+'/'+entry.runs[0]+'.json',held=proving+'.held';
 renameSync(proving,held);
 try {
  validateQuarantineVerdict(board,nativeReceipt);
  assert.throws(()=>store.recordProofRun(board,{agentId,itemId:item.item_id,receiptId:nativeReceipt.id}),
   error=>error.code==='PROOF_RUN_UNBOUND','origin custody must be sealed before the atomic proof append');
 } finally {renameSync(held,proving);}
});
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
withBoard(ctx,board=>{
 validateQuarantineProofIds(board,store.getItem(board,item.item_id),{agentId,ids:[nativeReceipt.id],kind:'submit',commit:nativeReceipt.head});
 assert.throws(()=>store.submit(board,item.item_id,{agentId,commit:git(root,['rev-parse','HEAD^']),tree:nativeReceipt.tree,gateGreen:true,quarantineProofIds:[nativeReceipt.id]}),error=>error.code==='PROOF_RUN_UNBOUND','a real proof from another source cannot authorize this submission');
 assert.ok(submitMove.minimumEngine([item.item_id,{quarantineProofIds:[nativeReceipt.id]}],board)>=QUARANTINE_VERDICT_ENGINE);
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
assert.equal(land.isGreen,true,JSON.stringify({output:land.output,stages:land.stages,profile:land.profile,receiptId:land.receiptId}));assert.equal(land.exitCode,1);
const landReceipt=readGateReceipt(receiptStore(root),land.receiptId);
assert.equal(checkTrainLandingReceipt(landReceipt,landReceipt.head).green,false);
withBoard(ctx,board=>assert.equal(readTrainLandingReceipt(root,board,landReceipt.id,landReceipt.head).id,landReceipt.id));
let savedBatch;
await withBoard(ctx,async board=>{
 const commit=git(root,['rev-parse','HEAD']);
 const state={board,config:{...config,affectedTests:null,registryGuards:[],submitInvariants:[]},
  batch:{version:1,id:randomUUID(),state:'merging',root,base:commit,tip:commit,branch:'refs/heads/main',
   owner:'coordinator-fixture',logPath:root+'/../logs/qfixture.log',items:[{id:item.item_id,commit}],revision:0},
  gates:new Map(),say(){},checkAtCommit,landingPorts:{flakeSource,observeNativeFailure,quarantineWaivers,quarantineVerdictSnapshot,validateQuarantineGate},
  write:(operation,args)=>ordered(ctx,board,operation,args)};
 const grouped=await gateGroup(state,'qfixture',{});
 assert.equal(grouped.isGreen,true);assert.equal(grouped.exitCode,1);
 assert.deepEqual(grouped.failures,[]);assert.deepEqual(grouped.accounted,[]);
 savedBatch=state.batch;
 assert.equal(savedBatch.gateResults[0].exitCode,1);
 assert.equal(savedBatch.gateResults[0].blockingVerdict.green,true);
 assert.deepEqual(savedBatch.invariantEvidence.gates[0].failures,[]);
 savedBatch=await state.write('recordLandingBatch',[{agentId,batch:{...savedBatch,proof:{tree:grouped.tree,logPath:grouped.logPath,failures:[]}},revision:savedBatch.revision}]);
 validateQuarantineLandingProof(board,savedBatch);
 assert.ok(finishMove.minimumEngine([{id:savedBatch.id}],board)>=QUARANTINE_VERDICT_ENGINE);
 const move=prepareEngineMove(board,'recordLandingBatch',[{agentId,batch:savedBatch,revision:savedBatch.revision}]);
 assert.ok(move.engine>=QUARANTINE_VERDICT_ENGINE);
});
const guards=await runLocalLandingGuard(root,config,{files:['test/control.test.js'],directory:root+'/../logs',label:'guard',onFailure:observer,
 quarantines,proofContext:{...proofContext,kind:'land'}});
assert.equal(guards.isGreen,true);assert.equal(guards.exitCode,1);
assert.ok(guards.proofReceiptId,'a selective landing exception keeps its own actual native receipt');
const deferred=await runDeferredAffectedTests(root,{...config,affectedTests:'node tooling/packages/gate/src/io/run/tests.js'},['test/control.test.js'],
 {directory:root+'/../logs',quarantines,proofContext:{...proofContext,kind:'land'}});
assert.equal(deferred.isGreen,true);assert.equal(deferred.exitCode,1);assert.ok(deferred.proofReceiptId);
const checkedItem=await withBoard(ctx,async board=>{
 const id=store.addItem(board,{by:agentId,lane:'web',title:'Quarantined actual private criterion',
  criterion:'The real committed test still executes while its active native quarantine changes only blocking authority.',check:config.gate});
 await ordered(ctx,board,'refreeze',[id,{agentId,freeze:freezer(ctx,{board})}]);
 return {...store.getItem(board,id),item_commit:git(root,['rev-parse','HEAD'])};
});
const privateRun=await withGateSlot(root,lease=>{
 lease.quarantines=quarantines;lease.proof={seat:agentId};
 return runFrozenProof(root,checkedItem,{gateLease:lease},{checkAtCommit});
},{executionServices,agent:agentId,kind:'review'});
assert.equal(privateRun.state,'pass',JSON.stringify(privateRun));
assert.equal(privateRun.exitCode,1);assert.equal(privateRun.rawState,'red');
const privateReceipt=readGateReceipt(receiptStore(root),privateRun.proofReceiptId);
assert.equal(privateReceipt.kind,'verdict');assert.equal(privateReceipt.proof.exitCode,1);
assert.equal(privateReceipt.green,false);assert.equal(receiptBlockingGreen(privateReceipt),true);
await withBoard(ctx,async board=>{
 await ordered(ctx,board,'recordProofRun',[{agentId,itemId:checkedItem.item_id,receiptId:privateReceipt.id}]);
 validateQuarantineProofIds(board,store.getItem(board,checkedItem.item_id),{agentId,ids:[privateReceipt.id],kind:'verdict',commit:privateReceipt.head,requireGreen:true});
 assert.ok(verifyMove.minimumEngine([checkedItem.item_id,{quarantineProofId:privateReceipt.id}],board)>=QUARANTINE_VERDICT_ENGINE);
});
const submit=await runSubmitGate(root,{...config,staticChecks:'',submitGate:'landing',submitInvariants:[],registryGuards:[],affectedTests:null},
 {base:git(root,['rev-parse','HEAD^']),trunk:git(root,['rev-parse','HEAD']),check:config.gate,agent:agentId,
  proofContext:{item:checkedItem.item_id,frozenDigest:checkedItem.item_frozen_digest,seat:agentId,quarantines},onFailure:observer,executionServices});
assert.equal(submit.isGreen,true);assert.equal(submit.check.green,true);
assert.equal(submit.check.rawExitCode,1);assert.equal(submit.phaseVerdicts[0].blockingVerdict.green,true);
assert.equal(readGateReceipt(receiptStore(root),submit.proofReceiptIds[0]).proof.exitCode,1);
// Real companion bytes produce a different commit; only that actually executed composition grants authority.
const source=git(root,['rev-parse','HEAD']),builderRoot=root+'-quarantine-builder';
git(root,['worktree','add','--detach',builderRoot,source]);
try {
 let builder,companionItem,binding;
 await withBoard(ctx,async board=>{
  builder=store.register(board,{lane:'web',path:builderRoot,model:'native fixture builder',family:'fixture'});
  const id=store.addItem(board,{by:agentId,lane:'web',title:'Actual quarantine companion composition',
   criterion:'The actual composed test source runs and keeps its raw red receipt.',check:config.gate});
  store.claim(board,id,{agentId:builder,lane:'web',leaseMs:120000,head:source,freeze:freezer(ctx,{board})});
  companionItem=store.getItem(board,id);
  const file='test/control.test.js',original=readFileSync(file,'utf8');
  let patch;
  try {
   writeFileSync(file,original.replace("assert.ok(!['red','mixed'].includes(mode))","assert.equal(!['red','mixed'].includes(mode),true)"));
   patch=git(root,['diff','--',file]);
  } finally {writeFileSync(file,original);}
  assert.ok(patch.includes('+'),'the companion is a real Git source delta');
  store.attachItemPatch(board,id,{agentId,key:'native-quarantine-companion',commit:source,patch:patch+String.fromCharCode(10),author:agentId});
  binding=prepareItemPatchSubmit(root,board,companionItem,source);
 });
 assert.notEqual(binding.commit,source);
 const composedConfig=submitGateConfig(policyAt(root,binding.commit).config,policyAt(root,source).config);
 const admission={commit:binding.commit,tree:binding.tree};
 const builderCtx=context({...io,cwd:builderRoot});
 const onWait=queuedItemLease(builderCtx,companionItem,builder,'build',admission);
 const composed=await withItemPatchSubmit(builderRoot,binding,gateRoot=>runSubmitGate(gateRoot,composedConfig,
  {base:source,trunk:source,check:config.gate,agent:builder,outputRoot:builderRoot,executionServices,
   onWait,
   proofContext:{companion:true,item:companionItem.item_id,frozenDigest:companionItem.item_frozen_digest,seat:builder,
    admission,quarantines}}));
 assert.equal(composed.isGreen,true,composed.output);
 assert.ok(composed.proofReceiptIds.length>0);
 binding.receiptIds=composed.proofReceiptIds;
 binding.phases=composed.phasePlan.map(({role,command})=>({role,command:createHash('sha256').update(command).digest('hex')}));
 await withBoard(ctx,async board=>{
  for(const receiptId of binding.receiptIds)await ordered(ctx,board,'recordProofRun',[{agentId:builder,itemId:companionItem.item_id,receiptId}]);
  const ids=binding.receiptIds.filter(id=>Object.hasOwn(readGateReceipt(receiptStore(builderRoot),id),'blockingVerdict'));
  assert.ok(ids.length>0);
  for(const commit of [source,git(root,['rev-parse','HEAD^'])])assert.throws(()=>validateQuarantineProofIds(board,companionItem,
   {agentId:builder,ids,kind:'submit',commit}),error=>error.code==='PROOF_RUN_UNBOUND','bare or older source cannot borrow the composed execution');
  store.submit(board,companionItem.item_id,{agentId:builder,commit:source,tree:binding.sourceTree,
   policyCommit:source,companion:binding,gateGreen:true,quarantineProofIds:ids,
   submissionProof:{version:1,files:composed.files,full:composed.full,deferred:composed.deferred,reason:composed.reason,
    ...(composed.deferredFiles?{deferredFiles:composed.deferredFiles}:{})}});
  assert.equal(store.getItem(board,companionItem.item_id).item_status,'submitted');
 });
} finally {git(root,['worktree','remove',builderRoot]);}
const unchanged=receiptBody(nativeReceipt);
assert.equal(receiptFields({...nativeReceipt,blockingVerdict:null}),null);
assert.equal(receiptFields({...nativeReceipt,proof:{...nativeReceipt.proof,exitCode:0}}),null);
const foreign=structuredClone(nativeReceipt);foreign.blockingVerdict.quarantines[0].eventId++;
withBoard(ctx,board=>assert.throws(()=>validateQuarantineVerdict(board,foreign),error=>error.code==='PROOF_RUN_UNBOUND'));
const legacy=readGateReceipt(receiptStore(root),red.receiptId);
assert.equal(Object.hasOwn(legacy,'blockingVerdict'),false);
assert.equal(Object.hasOwn(legacy,'failureSignatures'),false,'an absent producer preserves legacy receipt bytes');
assert.equal(receiptBody(receiptFields(JSON.parse(receiptBody(legacy)))),receiptBody(legacy));
// Twenty genuinely executed passes close this exact quarantine. A cached exception then loses authority.
for(let index=0;index<20;index++)await gate('green');
// The mixed run's red 'unrelated positive' and a later green on one tree are a same-tree pair, so commit f562d717d8 files it at once
// (a Submit-path run backfills its ratchet quarantine); only the original target closes here.
assert.deepEqual(snapshot().map(row=>row.name),['unrelated positive [C7]']);
withBoard(ctx,board=>{
 assert.throws(()=>validateQuarantineVerdict(board,nativeReceipt),error=>error.code==='PROOF_RUN_UNBOUND');
 assert.throws(()=>validateQuarantineGate(board,gateRecord),error=>error.code==='PROOF_RUN_UNBOUND');
 assert.throws(()=>store.submit(board,item.item_id,{agentId,commit:nativeReceipt.head,tree:nativeReceipt.tree,gateGreen:true,quarantineProofIds:[nativeReceipt.id]}),error=>error.code==='PROOF_RUN_UNBOUND','expiry between native proof/preflight and atomic submit refuses');
 assert.throws(()=>store.verify(board,checkedItem.item_id,{agentId,decision:'ACCEPT',note:'actual native private check',head:privateReceipt.head,digest:checkedItem.item_frozen_digest,review:{commit:privateReceipt.head,head:privateReceipt.head,trunk:privateReceipt.main,paths:[]},quarantineProofId:privateReceipt.id}),error=>error.code==='PROOF_RUN_UNBOUND','atomic acceptance also refuses a closed quarantine');
 assert.throws(()=>store.finishLandingBatch(board,{agentId,id:savedBatch.id,tip:savedBatch.tip}),error=>error.code==='PROOF_RUN_UNBOUND','atomic landing finish cannot revive its closed exception');
 assert.throws(()=>validateQuarantineLandingProof(board,savedBatch),error=>error.code==='PROOF_RUN_UNBOUND');
 validateQuarantineGate(board,gateRecord,{historical:true});
 store.recordLandingBatch(board,{agentId,batch:savedBatch,revision:savedBatch.revision});
 assert.equal(recordGateRun(board,{agentId,receipt,lane:'web'}).duplicate,true,'the original immutable event remains idempotent after closure');
 assert.equal(proofRunReceipt(board,{agentId,itemId:item.item_id,receiptId:native.proofReceiptId}).existing.id,nativeReceipt.id);
});
assert.equal(receiptBody(readGateReceipt(receiptStore(root),nativeReceipt.id)),unchanged);
console.log(JSON.stringify({actualGate:true,nativeProof:true,sourceAdvance:true,landing:true,privateVerify:true,submit:true,rawExit:1,closed:true}));
`;

test('every native quarantine verdict reader retains real raw red and rejects uncovered or expired authority [C7,H16]', async t => {
  const box = quarantineProject(t);
  const result = await runFixtureChildAsync(process.execPath, ['quarantine-driver.mjs'], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(report, { actualGate: true, nativeProof: true, sourceAdvance: true, landing: true, privateVerify: true, submit: true, rawExit: 1, closed: true });
});


test('quarantine continuation matches both file and name without granting a verdict [C7,H16]', () => {
  const rows = landingWaiverProjection(JSON.stringify([{ kind: 'case', test: TARGET, file: FILE }]));
  assert.equal(rows.length, 1);
  assert.equal(landingFailureWaived(rows, join(process.cwd(), FILE), TARGET), true);
  assert.equal(landingFailureWaived(rows, join(process.cwd(), 'test/another.test.js'), TARGET), false);
  assert.equal(landingFailureWaived(rows, join(process.cwd(), FILE), 'another failure [C7]'), false);
  for (const file of ['../escape.js', '/escape.js', 'test/../escape.js']) {
    assert.deepEqual(landingWaiverProjection(JSON.stringify([{ kind: 'case', test: TARGET, file }])), []);
  }
});
