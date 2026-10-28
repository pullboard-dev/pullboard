/** Structured native quarantine keeps actual red results and counts only executed identities [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyPackageFiles } from '../src/package-files.js';
import { testOutcomeFields } from '../src/test-outcomes.js';
import { testOutcomeCollector } from '../src/test-outcomes.js';
import { formatTestOutcomes } from '../src/test-outcomes.js';
import { readTestOutcomes } from '../src/test-outcomes.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { commitFixtureFiles } from './package-copy-fixture.js';
import { runFixtureChildAsync } from './fixture-child.js';

const TARGET = 'actual quarantine target [C7]';
const FILE = 'test/control.test.js';

/** Commit a complete installed runtime and one private test universe through ordinary fixture hooks. */
function quarantineProject(t) {
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
    lanes: { web: { owns: ['test/'], specs: [] } } }) + '\n');
  writeFileSync(join(box.repo, 'SPEC.md'), spec);
  writeFileSync(join(box.repo, FILE), `import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
const mode=process.env.PULLBOARD_QUARANTINE_CASE_MODE;
if(!['unrelated','suite'].includes(mode))test(${JSON.stringify(TARGET)},{skip:mode==='skip',todo:mode==='todo'},()=>assert.notEqual(mode,'red'));
if(mode==='suite')describe('unrelated suite [C7]',()=>test('suite child [C7]',()=>assert.equal(3+3,6)));
test('unrelated positive [C7]',()=>assert.equal(2+2,4));\n`);
  writeFileSync(join(box.repo, 'quarantine-driver.mjs'), DRIVER);
  commitFixtureFiles(box, box.git(box.repo, 'ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard').split('\0').filter(Boolean));
  const env = { ...box.env, PULLBOARD_TEST_REUSE: '0' };
  delete env.NODE_TEST_CONTEXT;
  return { ...box, env };
}

// This committed fixture program executes actual gate children and native ordered receipt moves; it fabricates no receipts.
const DRIVER = `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runGate} from './src/gate.js';
import {receiptRecorder} from './src/native-flake-receipts.js';
import {context,ordered,withBoard,resourceAgent} from './src/cli.js';
import {runnerExecutionServices} from './src/runners.js';
import {landingExecutionServices} from './src/landing-shards.js';
import {readGateReceipt,receiptStore} from './src/gate-run-receipt.js';
import {prepareEngineMove,applyEngineMove,appliedSequence} from './src/engine.js';
import {QUARANTINE_CORE_ENGINE} from './src/quarantine-core-engine.js';
import {quarantineWaivers} from './src/quarantine.js';
import {proofCounts} from './src/proof-provenance.js';
import * as store from './src/board.js';
const root=process.cwd(),config=JSON.parse(readFileSync('pullboard.json','utf8')),reports=[];
const ctx=context({cwd:root,say:text=>reports.push(text),err:text=>reports.push(text)});
const agentId=resourceAgent(ctx);
const observer=Object.assign(async()=>{}, {recordRun:receiptRecorder(ctx,{agentId,acceptedConfig:config,ordered,withBoard})});
const executionServices={runners:runnerExecutionServices(),landing:landingExecutionServices()};
/** Read public projections while retaining the actual fixture board boundary. */
const snapshot=()=>withBoard(ctx,board=>({runs:store.gateRuns(board),quarantines:store.flakeQuarantines(board),items:store.listItems(board,{all:true}),waivers:quarantineWaivers(board)}));
/** Force a genuine fresh gate through normal admission, retaining its canonical private receipt. */
async function run(mode){
 process.env.PULLBOARD_QUARANTINE_CASE_MODE=mode;
 const value=await runGate(root,config,{trustStamp:false,agent:agentId,onFailure:observer,executionServices});
 const receipt=readGateReceipt(receiptStore(root),value.receiptId);
 assert.ok(receipt?.testOutcomes,'actual native outcomes must survive reporters, receipt normalization and recording');
 assert.equal(value.isGreen,mode!=='red');
 assert.equal(receipt.green,mode!=='red','the canonical receipt preserves the actual red');
 return {value,receipt};
}
const red=await run('red');
assert.equal(red.value.exitCode,1,'the original process exit is preserved');
assert.equal(proofCounts(red.value.output).failed,1,'the actual failed counter is preserved');
assert.equal(snapshot().quarantines.length,0,'the first new failure cannot quarantine itself');
const green=await run('green');
let state=snapshot();
assert.equal(state.items.length,1);
assert.equal(state.items[0].item_lane,'web');
assert.equal(state.quarantines[0].nativeCore,true);
assert.equal(state.quarantines[0].status,'quarantined');
assert.equal(state.quarantines[0].cleanRuns,0,'the proving pass is not one of the subsequent clean runs');
assert.equal(red.receipt.tree,green.receipt.tree);
assert.deepEqual(state.quarantines[0].runs,[red.receipt.id,green.receipt.id]);
assert.match(state.items[0].item_brief,new RegExp(red.receipt.id));
assert.match(state.items[0].item_brief,new RegExp(green.receipt.id));
assert.match(state.items[0].item_brief,new RegExp(red.receipt.tree));
assert.equal(state.items[0].item_created_at.slice(0,10),green.receipt.at.slice(0,10),'owner work is filed the same day');
assert.deepEqual(state.waivers,[],'this narrowed change does not promote a new quarantine into landing authority');
await withBoard(ctx,async board=>{
 const count=store.gateRuns(board).length;
 const again=await ordered(ctx,board,'recordGateRun',[{agentId,receipt:green.receipt,lane:'web',owners:{'test/control.test.js':'web'}}]);
 assert.equal(again.duplicate,true);
 assert.equal(store.gateRuns(board).length,count,'duplicate receipt reuse appends no new run');
 assert.equal(store.flakeQuarantines(board)[0].cleanRuns,0,'duplicate receipt reuse adds no clean execution');
 const move=prepareEngineMove(board,'recordGateRun',[{agentId,receipt:green.receipt,lane:'web'}]);
 assert.ok(move.engine>=QUARANTINE_CORE_ENGINE);
 const sequence=appliedSequence(board)+1;
 assert.throws(()=>applyEngineMove(board,{...move,id:'old-floor-control',engine:QUARANTINE_CORE_ENGINE-1},{sequence,at:new Date().toISOString()}),error=>error.code==='RELAY_MOVE');
 assert.equal(appliedSequence(board),sequence-1,'an old receiver refuses before moving its replay cursor');
});
const again=await run('red');
assert.equal(again.value.isGreen,false,'a quarantined failure remains an actual blocking red in this item');
assert.equal(again.value.exitCode,1);
assert.equal(proofCounts(again.value.output).failed,1);
assert.match(reports.join('\\n'),/quarantined: test\\/control.test.js :: actual quarantine target/);
assert.match(again.value.output,/actual quarantine target/,'the quarantined test still executes and reports');
assert.equal(snapshot().items.length,1,'later contradictions do not file duplicate owner work');
for(let index=0;index<19;index++)await run('green');
assert.equal(snapshot().quarantines[0].cleanRuns,19);
await run('skip');
await run('todo');
await run('suite');
await run('unrelated');
assert.equal(snapshot().quarantines[0].cleanRuns,19,'skipped, todo, suite and unrelated green runs never count');
await run('green');
state=snapshot();
assert.equal(state.quarantines[0].cleanRuns,20);
assert.equal(state.quarantines[0].status,'lifted');
assert.equal(state.items.length,1);
console.log(JSON.stringify({quarantineCore:true,runs:state.runs.length,rawRed:red.receipt.green,release:state.quarantines[0]}));
`;

test('native same-tree test verdicts file once, still report raw red, and release after 20 executed passes [C7,H16]', async t => {
  const box = quarantineProject(t);
  const result = await runFixtureChildAsync(process.execPath, ['quarantine-driver.mjs'], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(report.quarantineCore, true);
  assert.equal(report.rawRed, false);
  assert.equal(report.release.cleanRuns, 20);
});

test('structured native outcomes reject duplicates, reporter text and incomplete or cancelled evidence [C7,H16]', () => {
  const row = { file: FILE, name: TARGET, passed: true, skipped: false };
  const id = randomUUID();
  assert.deepEqual(readTestOutcomes(formatTestOutcomes(id, [row]), id), [row]);
  assert.equal(readTestOutcomes(formatTestOutcomes(id, [row]), randomUUID()), null);
  assert.equal(readTestOutcomes('ok 1 - invented pass', id), null);
  assert.equal(readTestOutcomes(formatTestOutcomes(id, [row]).repeat(2), id), null);
  for (const file of ['../control.js', '/control.js', 'C:/control.js']) assert.equal(testOutcomeFields([{ ...row, file }]), null);
  assert.equal(testOutcomeFields([row, row]), null);
  const collector = testOutcomeCollector('/private/repo');
  collector.observe({ type: 'test:stdout', data: { message: formatTestOutcomes(id, [row]) } });
  assert.equal(collector.finish(true, 1), null, 'test stdout never becomes a structured result');
  collector.observe({ type: 'test:pass', data: { file: '/private/repo/' + FILE, name: TARGET, details: { type: 'test' } } });
  assert.equal(collector.finish(false, 1), null);
  assert.deepEqual(collector.finish(true, 1), [row]);
  collector.observe({ type: 'test:fail', data: { file: '/private/repo/' + FILE, name: 'cancelled', details: { error: { failureType: 'cancelledByParent' } } } });
  assert.equal(collector.finish(true, 2), null);
});
