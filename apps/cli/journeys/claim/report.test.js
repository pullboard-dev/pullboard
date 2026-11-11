/** A new or changed gate refusal reports what it would refuse for 20 real gates, then enforces [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { CLEAN_GATES_TO_ENFORCE } from '../../../../packages/gate/index.js';
import { ENFORCED_REFUSALS } from '../../../../packages/gate/index.js';
import { countTrialGate } from '../../../../packages/gate/index.js';
import { gateRefuse } from '../../../../packages/gate/index.js';
import { recordFalseRefusal } from '../../../../packages/gate/index.js';
import { refusalMode } from '../../../../packages/gate/index.js';
import { awaitNestedRun } from '../../../../packages/gate/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
import { foreignNodeOptions } from '../../../../packages/gate/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import { fixture as cellFixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git as cellGit } from '../../../../packages/landing/tests/fixtures/plan.js';
import { publishAcceptedCells } from '../../../../packages/landing/tests/fixtures/plan.js';
import { acceptedCutItems } from '../../../../packages/landing/tests/fixtures/plan.js';
import { computePlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { requireSubmitCells } from '../../index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** A private ledger for deterministic rule controls; real gate integration is exercised separately below. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-refusal-trial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'refusal-trials.json'), output = [];
  /** Exercise one rule and advance its isolated observation counter. */
  const gate = (code, options = {}) => {
    try {
      gateRefuse(dir, code, 'the fixture case', line => output.push(line), { file, ...options });
      return 'passed';
    } catch (error) { return error.code; } finally { output.push(...countTrialGate(dir, { file })); }
  };
  return { dir, file, output, gate };
}

test('a made-up new refusal code reports "would refuse" and the gate passes, for gates 1 to 20, and refuses at gate 21 [C7]', t => {
  const box = fixture(t);
  assert.equal(CLEAN_GATES_TO_ENFORCE, 20);
  assert.ok(!ENFORCED_REFUSALS.has('FIXTURE_NEW_RULE'), 'the code is new: it was not enforced when the list was frozen');
  for (let number = 1; number <= 20; number++) {
    assert.equal(box.gate('FIXTURE_NEW_RULE'), 'passed', `gate ${number} passes: the new refusal only reports`);
    assert.ok(box.output.includes(`would refuse FIXTURE_NEW_RULE (report-only, ${number - 1}/20 clean gates): the fixture case`), `gate ${number} records what it would refuse`);
  }
  assert.ok(box.output.includes('refusal trial FIXTURE_NEW_RULE: enforce (20/20 clean gates)'), 'the 20th gate records the trial is over');
  assert.equal(box.gate('FIXTURE_NEW_RULE'), 'FIXTURE_NEW_RULE', 'gate 21 refuses');
});

test('a refusal enforced when the list was frozen refuses at once, and a changed one goes back on trial [C7]', t => {
  const box = fixture(t);
  assert.ok(ENFORCED_REFUSALS.has('GATE_RED') && ENFORCED_REFUSALS.size > 500, 'today\'s refusal codes are the enforced baseline');
  assert.equal(box.gate('GATE_RED'), 'GATE_RED');
  assert.equal(box.gate('GATE_RED', { changed: { GATE_RED: '#2611 fixture change' } }), 'passed');
});

test('a recorded false refusal restarts the trial [C7]', t => {
  const box = fixture(t);
  for (let number = 1; number <= 19; number++) box.gate('FIXTURE_NEW_RULE');
  recordFalseRefusal(box.dir, 'FIXTURE_NEW_RULE', { file: box.file });
  assert.deepEqual(refusalMode(box.dir, 'FIXTURE_NEW_RULE', { file: box.file }), { mode: 'report', clean: 0 });
  assert.equal(JSON.parse(readFileSync(box.file, 'utf8')).codes.FIXTURE_NEW_RULE.falseRefusals, 1);
  assert.equal(box.gate('FIXTURE_NEW_RULE'), 'passed');
});

test('a second change to the same refusal starts a fresh twenty-gate trial [C7]', t => {
  const box = fixture(t);
  const first = { changed: { GATE_RED: 'first rule content' } };
  const second = { changed: { GATE_RED: 'second rule content' } };
  for (let number = 1; number <= 20; number++) assert.equal(box.gate('GATE_RED', first), 'passed');
  assert.equal(box.gate('GATE_RED', first), 'GATE_RED');
  for (let number = 1; number <= 20; number++) assert.equal(box.gate('GATE_RED', second), 'passed');
  assert.equal(box.gate('GATE_RED', second), 'GATE_RED');
});

test('a new refusal with changed rule content restarts its trial [C7]', t => {
  const box = fixture(t);
  for (let number = 1; number <= 20; number++) assert.equal(box.gate('FIXTURE_NEW_RULE', { rule: 'initial rule source' }), 'passed');
  assert.equal(box.gate('FIXTURE_NEW_RULE', { rule: 'initial rule source' }), 'FIXTURE_NEW_RULE');
  assert.equal(box.gate('FIXTURE_NEW_RULE', { rule: 'updated rule source' }), 'passed');
});

test('twenty native source-bound gates report a real composition guard and gate twenty-one enforces [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const log = join(box.dir, 'executions');
  const red = join(box.dir, 'red');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/value.txt'), '1');
  writeFileSync(join(box.repo, 'proof.cjs'), `const fs=require('node:fs');
if(fs.readFileSync('web/value.txt','utf8')!=='2'||fs.existsSync(${JSON.stringify(red)}))process.exit(1);
fs.appendFileSync(${JSON.stringify(log)},'proof\\n');
`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: native proof source [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Native gate observations', '--specs', 'G1', '--criterion', 'The value is two.', '--check', 'node proof.cjs', '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const item = JSON.parse(added.out).item.item_id;
  const claimed = box.run(box.web, 'claim', String(item), '--json');
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  assert.match(JSON.parse(claimed.out).digest, /^[a-f0-9]{64}$/u);
  writeFileSync(join(box.web, 'web/value.txt'), '2');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): supply the native checked value [G1]');
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  box.git(box.repo, 'commit', '-q', '--allow-empty', '-m', 'chore: move accepted main');
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  /** Name only the actual installed tool source, never a copied fixture implementation. */
  const tool = relative => pathToFileURL(resolve(import.meta.dirname, '../../../..', relative)).href;
  const gateURL = tool('packages/gate/index.js');
  const driver = join(box.dir, 'native-gates.mjs');
  writeFileSync(driver, `import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {runSubmitGate,runMachineryGuard,countTrialGate,refusalTrialFile,requireTestTierAccount,readGateReceipt,receiptStore} from ${JSON.stringify(gateURL)};
import {requireSubmitComposition,requirePlannedSource} from ${JSON.stringify(tool('packages/items/index.js'))};
import {loadConfig} from ${JSON.stringify(tool('packages/config/index.js'))};
import {Refused} from ${JSON.stringify(tool('packages/kernel/index.js'))};
${executionServicesSource(gateURL)}
const root=${JSON.stringify(box.web)},head=${JSON.stringify(head)},main=${JSON.stringify(main)},item=${item};
const notes=[],ids=[];
let observed=[];
const options={kind:'composition',rule:requireSubmitComposition.toString(),say:text=>notes.push(text)};
/** Run the actual composition guard, never a stand-in refusal. */
const guard=()=>runMachineryGuard(root,()=>requireSubmitComposition(root,head,{commit:main},main),options);
/** Execute the actual frozen command and bind native receipts to this real claim. */
const run=()=>runSubmitGate(root,loadConfig(root),{executionServices,base:head,trunk:main,check:'node proof.cjs',agent:'web-1',item:String(item),staticChecked:true,
proofContext:{item,seat:'web-1',frozenDigest:${JSON.stringify(JSON.parse(claimed.out).digest)}}});
for(let number=1;number<=20;number++){
  await guard();
  const proof=await run();
  assert.equal(proof.isGreen,true);
  assert.ok(proof.proofReceiptIds.some(id=>typeof id==='string'));
  observed=proof.proofReceiptIds.filter(id=>typeof id==='string');
  for(const id of observed){
    const receipt=readGateReceipt(receiptStore(root),id);
    assert.equal(receipt.head,head);assert.equal(receipt.green,true);ids.push(id);
  }
  assert.equal(JSON.parse(readFileSync(refusalTrialFile(root),'utf8')).gates,number);
}
await assert.rejects(guard(),{code:'MAIN_NOT_COMPOSED'});
assert.equal(new Set(ids).size,ids.length);
const last=JSON.parse(readFileSync(refusalTrialFile(root),'utf8')).gates;
assert.equal(countTrialGate(root,{id:JSON.stringify([...observed].sort())}).length,0);
assert.equal(JSON.parse(readFileSync(refusalTrialFile(root),'utf8')).gates,last);
for(const code of ['GATE_RED','NOT_YOURS','RUNNER_SOURCE','RUNNER_RESULT_INVALID']){
  await assert.rejects(runMachineryGuard(root,()=>{throw new Refused(code,'protected');},{kind:'doctrine',rule:'changed owner',say:()=>{}}),{code});
}
await assert.rejects(runMachineryGuard(root,()=>requireTestTierAccount({green:true,profile:{tests:[]}},['test/selected.test.js']),
  {kind:'selection',rule:'changed coverage rule',say:()=>{}}),{code:'TEST_SELECTION_UNVERIFIED'});
await assert.rejects(runMachineryGuard(root,()=>requirePlannedSource(root,'0'.repeat(40),head),
  {kind:'placement',rule:'changed placement',say:()=>{}}),{code:'GIT_READ_INFRASTRUCTURE'});
writeFileSync(${JSON.stringify(red)},'red');
const failed=await run();assert.equal(failed.isGreen,false);
assert.equal(JSON.parse(readFileSync(refusalTrialFile(root),'utf8')).gates,20);
assert.equal(readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').length,20);
assert.equal(notes.filter(line=>line.startsWith('would refuse MAIN_NOT_COMPOSED')).length,20);
process.stdout.write('NATIVE_TRIAL '+JSON.stringify({gates:20,enforced:21,executions:20,protected:true})+'\\n');
`);
  const env = Object.fromEntries(Object.entries(box.env).filter(([key]) => !key.startsWith('PULLBOARD_') && !['NODE_OPTIONS', 'NODE_TEST_CONTEXT'].includes(key)));
  Object.assign(env, { PULLBOARD_HOME: box.env.PULLBOARD_HOME, PULLBOARD_MACHINE_HOME: box.env.PULLBOARD_MACHINE_HOME });
  const result = await awaitNestedRun(runFixtureChildAsync(process.execPath, [driver], { cwd: box.web, env, encoding: 'utf8', signal: t.signal }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const line = result.stdout.split('\n').find(row => row.startsWith('NATIVE_TRIAL '));
  assert.deepEqual(JSON.parse(line.slice('NATIVE_TRIAL '.length)), { gates: 20, enforced: 21, executions: 20, protected: true });
});

test('concurrent ledger writers count each observation once without losing increments [C7]', async t => {
  const box = fixture(t);
  const module = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/gate/index.js')).href;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const runs = [0, 1, 2, 3].map(worker => runFixtureChildAsync(process.execPath, ['--input-type=module', '-e',
    `import {countTrialGate} from ${JSON.stringify(module)};for(let index=0;index<25;index++){const options={file:${JSON.stringify(box.file)},id:${worker}+':'+index};countTrialGate('.',options);countTrialGate('.',options);}`],
  { env, encoding: 'utf8', signal: t.signal }));
  const results = [];
  for (const run of runs) results.push(await awaitNestedRun(run));
  for (const result of results) assert.equal(result.status, 0, result.stdout + result.stderr);
  const ledger = JSON.parse(readFileSync(box.file, 'utf8'));
  assert.equal(ledger.gates, 100);
  assert.equal(Object.keys(ledger.seen).length, 100);
});

test('collected placement diagnostics preserve complete source checks and cached rule identity [C7]', async t => {
  const box = cellFixture(t);
  writePlan(box.root, computePlan(box.root));
  cellGit(box.root, 'add', '-A'); cellGit(box.root, 'commit', '-q', '-m', 'private accepted placement');
  const main = cellGit(box.root, 'rev-parse', 'HEAD');
  const artifact = await publishAcceptedCells(t, box.root, main);
  box.put('src/new-trial-leaf.js', 'export const value = 1;\n');
  cellGit(box.root, 'add', '-A'); cellGit(box.root, 'commit', '-q', '-m', 'private missing placement');
  const candidate = cellGit(box.root, 'rev-parse', 'HEAD');
  const item = { item_title: 'Cells shim removal fixture', item_frozen: JSON.stringify({ criterion: 'Cells shim removal fixture.' }) };
  const services = { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache,
    acceptedArtifact: artifact, cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS), readCutItems: () => acceptedCutItems(box.root, main) };
  await assert.rejects(requireSubmitCells(box.root, main, candidate, item, services), { code: 'CELLS_PLAN_UNPLACED' });
  const result = await requireSubmitCells(box.root, main, candidate, item, { ...services, collectMachinery: true });
  const placement = result.machinery.find(row => row.kind === 'placement');
  assert.equal(placement.code, 'CELLS_PLAN_UNPLACED');
  assert.match(placement.message, /src\/new-trial-leaf\.js/u);
  assert.match(placement.rule, /^[a-f0-9]{64}$/u);
  const repeated = await requireSubmitCells(box.root, main, candidate, item, { ...services, collectMachinery: true });
  assert.deepEqual(repeated.machinery, result.machinery);
  unlinkSync(join(box.root, 'packages/codemap/data/plan/cells.json'));
  symlinkSync('../outside-plan.json', join(box.root, 'packages/codemap/data/plan/cells.json'));
  cellGit(box.root, 'add', '-A'); cellGit(box.root, 'commit', '-q', '-m', 'private symbolic plan control');
  await assert.rejects(requireSubmitCells(box.root, main, cellGit(box.root, 'rev-parse', 'HEAD'), item, { ...services, collectMachinery: true }),
    error => error.code === 'CELLS_SUBMIT' && /symbolic candidate plan/u.test(error.message));
});
