import { flakeQuarantines as nativeFlakeQuarantines } from '../../../../packages/flakes/index.js';
import { gateRuns as nativeGateRuns } from '../../../../packages/flakes/index.js';
import { recordGateRun as nativeRecordGateRun } from '../../../../packages/flakes/index.js';
/** Actual native suite and gate receipts retain source-bound phases through board recording and replay [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import {
  readGateReceipt,
  receiptFields,
  receiptStore,
} from '../../../../packages/gate/index.js';
import {
  formatSuiteTiming,
  suiteTimingFromOutput,
  SUITE_TIMING_PREFIX,
  timingAccountingStages,
} from '../../../../packages/gate/index.js';
import { RUN_TIMING_ENGINE } from '../../../../packages/state/light.js';
import {
  prepareEngineMove,
  applyEngineMove,
  appliedSequence,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { eventMetrics } from '../../../../docs/tools/case-study/events.js';
import { commitFixtureFiles } from '../../tests/fixtures/copy.js';
import { COLLECTION_REPORT_PREFIX } from '../../../../packages/gate/index.js';
import { formatCollectionReport } from '../../../../packages/gate/index.js';
import { randomUUID } from 'node:crypto';
import * as store from '../../../../packages/store/index.js';
import {
  openBoardForRead,
  openBoard,
} from '../../../lib/index.js';

/** Keep a real installed runtime but give the fixture its own two-file committed test universe. */
function timingProject(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node apps/cli/src/io/run/tests.js', helpers.sandbox(), { withWorktree: false });
  const config = readFileSync(join(box.repo, 'pullboard.json'), 'utf8');
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const copied = copyPackageFiles(join(import.meta.dirname, '../../../..'), box.repo);
  // Selective fixture: the installed runtime is real; shipped documentation tests are a different test universe.
  for (const file of copied) if (file !== 'package.json' && !/^(?:src|bin|packages|apps)\//u.test(file)) rmSync(join(box.repo, file), { force: true });
  for (const file of copied) if (/\.test\.[cm]?js$/u.test(file)) rmSync(join(box.repo, file), { force: true });
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...JSON.parse(config), landingShards: 2,
    affectedTests: 'node apps/cli/src/io/run/tests.js', flakes: { rerun: false } }));
  writeFileSync(join(box.repo, 'SPEC.md'), spec);
  writeFileSync(join(box.repo, 'test/one.test.js'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('first actual timing case [C7]',t=>{t.diagnostic('timing-leaf-node '+process.versions.node);assert.equal(process.env.PULLBOARD_TIMING_FIXTURE_RED,'0');});\n");
  writeFileSync(join(box.repo, 'test/two.test.js'), "import {test} from 'node:test'; test('second actual timing case [C7]',()=>{});\n");
  commitFixtureFiles(box, box.git(box.repo, 'ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard')
    .split('\0').filter(Boolean));
  const env = { ...box.env, PULLBOARD_TEST_REUSE: '0', PULLBOARD_TIMING_FIXTURE_RED: '0' };
  for (const key of ['NODE_TEST_CONTEXT', 'PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN',
    'PULLBOARD_LANDING_RUN', 'PULLBOARD_LANDING_SHARD', 'PULLBOARD_LANDING_COLLECTION_ID', 'PULLBOARD_TIMING_RUN_ID']) delete env[key];
  return { ...box, env, head: box.git(box.repo, 'rev-parse', 'HEAD'), tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') };
}

/** Read the native recorded history through its existing public board projection. */
function recorded(box) {
  const board = openBoardForRead(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  assert.ok(board);
  try { return nativeGateRuns(board); } finally { store.closeBoard(board); }
}

/** Check measurements rather than impose a latency target or infer a total from overlapping shards. */
function assertMeasured(run, box, output) {
  assert.equal(run.head, box.head);
  assert.equal(run.tree, box.tree);
  assert.match(run.timing.node, /^\d+\.\d+\.\d+/u);
  if (output !== undefined) {
    const actualNode = /timing-leaf-node (\d+\.\d+\.\d+)/u.exec(output)?.[1];
    assert.ok(actualNode, 'a real test process reports its actual Node version');
    assert.equal(run.timing.node, actualNode);
  }
  for (const name of ['wallMs', 'selectionMs', 'setupMs']) assert.ok(Number.isFinite(run.timing[name]) && run.timing[name] >= 0, name);
  assert.equal(run.timing.compareMs, null, 'no main-failure comparison ran in this suite');
  assert.ok(run.timing.shards.length > 0);
  for (const shard of run.timing.shards) assert.ok(Number.isFinite(shard.wallMs) && shard.wallMs >= 0);
  const privateReceipt = readGateReceipt(receiptStore(box.repo), run.id);
  assert.deepEqual(privateReceipt.timing, run.timing, 'native board history retains every canonical phase');
}

test('a direct full suite records one durable source-bound run, including a complete red run [C7,H16]', async t => {
  const box = timingProject(t);
  // Process-level: a direct suite-runner process, its exit code and stdout frames are the behaviour under test.
  const run = async red => runFixtureChildAsync(process.execPath, ['apps/cli/src/io/run/tests.js'],
    { cwd: box.repo, env: { ...box.env, PULLBOARD_TIMING_FIXTURE_RED: red }, encoding: 'utf8' });
  const green = await run('0');
  assert.equal(green.status, 0, green.stderr + green.stdout);
  const first = recorded(box);
  assert.equal(first.length, 1, 'the forwarding controller and test-file children add no duplicate suite records');
  assert.equal(first[0].kind, 'suite');
  assert.equal(first[0].green, true);
  assert.equal(first[0].full, true);
  assertMeasured(first[0], box, green.stdout);
  const red = await run('1');
  assert.equal(red.status, 1, red.stderr + red.stdout);
  const both = recorded(box);
  assert.equal(both.length, 2);
  assert.equal(both[1].green, false);
  assert.equal(both[1].full, true, 'both committed files completed even though a real assertion failed');
  assertMeasured(both[1], box, red.stdout);
  const board = openBoardForRead(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { assert.deepEqual(nativeFlakeQuarantines(board), [], 'direct-suite evidence cannot establish a quarantine'); }
  finally { store.closeBoard(board); }
  // Process-level: the direct suite runner's stdout timing frame.
  const filtered = await runFixtureChildAsync(process.execPath, ['apps/cli/src/io/run/tests.js', '--test-skip-pattern=first', 'test/one.test.js', 'test/two.test.js'],
    { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(filtered.status, 0, filtered.stderr + filtered.stdout);
  const frame = filtered.stdout.split('\n').find(line => line.startsWith(SUITE_TIMING_PREFIX));
  assert.ok(frame);
  assert.equal(JSON.parse(frame.slice(SUITE_TIMING_PREFIX.length)).full, false, 'deliberately skipped bodies never claim full coverage');
  const metrics = eventMetrics(join(box.repo, '.git', 'pullboard', 'board.sqlite'),
    { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' });
  assert.equal(metrics.proofReceipts.fullSuite.n, 2, 'the case study reads the two real native full-suite wall observations from the board');
});

test('a sharded landing retains each actual attempt and immutable board-bound timing [C7,H16]', async t => {
  const box = timingProject(t);
  const replica = fixtureBoard(t);
  const initial = openBoardForRead(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { importBoard(replica, exportBoard(initial)); } finally { store.closeBoard(initial); }
  const source = `import {runGate} from './packages/gate/index.js';
import {runnerExecutionServices} from './packages/runners/index.js';
import {landingExecutionServices} from './packages/landing/index.js';
const executionServices={runners:runnerExecutionServices(),landing:landingExecutionServices()};
 import * as store from './packages/store/index.js'; import {openBoard} from './apps/lib/index.js';
import {readFileSync} from 'node:fs'; import {readGateReceipt,receiptStore} from './packages/gate/index.js';
const run=await runGate(process.cwd(),JSON.parse(readFileSync('pullboard.json','utf8')),{ executionServices,trustStamp:false,landing:true,agent:'coordinator'});
if(!run.isGreen) throw new Error(run.output);
const receipt=readGateReceipt(receiptStore(process.cwd()),run.receiptId);
const board=openBoard('.git/pullboard/board.sqlite');
try { board.enginePorts.store.recordGateRun(board,{agentId:'coordinator',receipt,lane:'web'}); } finally {store.closeBoard(board);}
console.log(run.output); console.log(JSON.stringify({receiptId:run.receiptId}));`;
  // Process-level: runs the fixture repo's own installed runtime as a separate node process.
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const rows = recorded(box);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'land');
  assert.equal(rows[0].full, true);
  assertMeasured(rows[0], box, result.stdout);
  assert.deepEqual(rows[0].timing.shards.map(row => row.shard).sort(), ['1/2', '2/2']);
  const legacy = structuredClone(readGateReceipt(receiptStore(box.repo), rows[0].id));
  delete legacy.full;
  delete legacy.timing;
  const normalized = receiptFields(legacy);
  assert.ok(normalized);
  assert.equal(normalized.timing ?? null, null, 'legacy phase times remain unknown');
  assert.equal(normalized.full ?? null, null, 'legacy full coverage remains unknown');
  // @pullboard-board-file persistence: bind native receipts to this fixture's actual store before sealed replay and tamper checks.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const receipt = readGateReceipt(receiptStore(box.repo), rows[0].id);
    const move = prepareEngineMove(board, 'recordGateRun', [{ agentId: 'coordinator', receipt, lane: 'web' }]);
    const sequence = appliedSequence(replica) + 1;
    const at = new Date().toISOString();
    assert.throws(() => applyEngineMove(replica, { ...move, engine: RUN_TIMING_ENGINE - 1 }, { sequence, at }),
      error => error.code === 'RELAY_MOVE', 'an older receiver cannot silently discard the actual phase evidence');
    assert.equal(appliedSequence(replica), sequence - 1);
    assert.equal(applyEngineMove(replica, move, { sequence, at }).error, undefined);
    assert.deepEqual(nativeGateRuns(replica).find(row => row.id === receipt.id).timing, receipt.timing);
    const changed = structuredClone(rows[0]);
    changed.timing.wallMs += 1;
    assert.throws(() => nativeRecordGateRun(board, { agentId: 'coordinator', receipt: changed, lane: 'web' }),
      error => error.code === 'GATE_RUN_UNBOUND', 'altering an actual phase cannot reuse its native receipt');
  } finally { store.closeBoard(board); }
});

test('a selected real landing failure remains accounted under its native private waiver [C7,H16]', async t => {
  const box = timingProject(t);
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, landingShards: 1,
    gate: 'node apps/cli/src/io/run/tests.js --test-concurrency=1 test/one.test.js' }) + '\n');
  commitFixtureFiles(box, ['pullboard.json']);
  const source = `import {readFileSync,existsSync} from 'node:fs';
import {runGate} from './packages/gate/index.js'; import * as store from './packages/store/index.js'; import {openBoard} from './apps/lib/index.js';
import {accountedFailures,waivedFailures,liveWaiverProjection} from './packages/landing/index.js';
import {runnerExecutionServices} from './packages/runners/index.js';
import {landingExecutionServices} from './packages/landing/index.js';
const executionServices={runners:runnerExecutionServices(),landing:landingExecutionServices()};
import {readGateReceipt,receiptStore} from './packages/gate/index.js';
import {quarantineWaivers} from './packages/flakes/index.js';
const landingPorts={quarantineWaivers};
const root=process.cwd(),config=JSON.parse(readFileSync('pullboard.json','utf8'));
// @pullboard-board-file persistence: install and read a live native waiver in this private fixture's actual board.
const board=openBoard('.git/pullboard/board.sqlite');
try {
const waiver=store.recordLandingWaiver(board,{agentId:'person',channel:'terminal',id:'timing-selected-native-waiver',
 test:'test/one.test.js',until:'2099-01-01',reason:'private selected landing accounting regression'});
const run=await runGate(root,config,{executionServices,landing:true,stages:true,trustStamp:false,agent:'coordinator',waivers:liveWaiverProjection(board,landingPorts)});
const accounted=accountedFailures(run,root),covered=waivedFailures(board,accounted,landingPorts);
const receipt=readGateReceipt(receiptStore(root),run.receiptId);
console.log(JSON.stringify({raw:run.output,stages:run.stages,source:{commit:receipt.head,tree:receipt.tree},
 green:run.isGreen,waiver,accounted,covered,stamp:existsSync('.git/pullboard-gate-green')}));
} finally {store.closeBoard(board);}`;
  // Process-level: runs the fixture repo's own installed runtime as a separate node process.
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source],
    { cwd: box.repo, env: { ...box.env, PULLBOARD_TIMING_FIXTURE_RED: '1' }, encoding: 'utf8' });
  t.diagnostic(JSON.stringify({ stage: 'actual selected landing capture', status: result.status,
    stdout: result.stdout, stderr: result.stderr }));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const capture = JSON.parse(result.stdout.trim());
  assert.equal(capture.green, false, 'the real assertion failure remains red');
  assert.match(capture.raw, /first actual timing case/u);
  assert.match(capture.raw, /^# tests 1$/mu);
  assert.match(capture.raw, /^# fail 1$/mu);
  assert.ok(Array.isArray(capture.stages) && capture.stages.length > 0, 'actual execution stages are captured');
  assert.equal(capture.source?.commit, box.git(box.repo, 'rev-parse', 'HEAD'));
  assert.equal(capture.source?.tree, box.git(box.repo, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(capture.accounted?.length, 1, 'the complete real TAP account names exactly one failure');
  assert.equal(capture.covered?.length, 1, 'the native private waiver covers that actual failure');
  assert.equal(capture.covered[0].file, 'test/one.test.js');
  assert.equal(capture.covered[0].waiver.id, capture.waiver.id);
  assert.equal(capture.stamp, false, 'a waived red run never leaves an ordinary green stamp');
});

test('an all-reused direct invocation preserves a receipt without inventing a fresh full suite [C7,H16]', async t => {
  const box = timingProject(t);
  const env = { ...box.env, PULLBOARD_TEST_REUSE: '1' };
  // Process-level: direct suite-runner processes sharing a reuse cache.
  const first = await runFixtureChildAsync(process.execPath, ['apps/cli/src/io/run/tests.js'], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const second = await runFixtureChildAsync(process.execPath, ['apps/cli/src/io/run/tests.js'], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.match(second.stdout, /# reused/u, 'the native cache really reused the seeded file results');
  const runs = recorded(box);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].full, true);
  assert.equal(runs[1].full, false);
  assert.deepEqual(runs[1].timing.shards, [], 'there was no fresh shard attempt');
  assert.equal(runs[1].timing.setupMs, null, 'a phase that never ran is unknown rather than zero');
});

test('a real red publish preflight retains its board receipt and does not rerun the same head [C7,H16]', async t => {
  const box = timingProject(t);
  const remote = join(box.dir, 'timing-origin.git');
  box.git(box.dir, 'init', '--bare', '-q', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'remote', 'set-url', '--push', 'origin', join(box.dir, 'nonexistent-push-target'));
  const publish = () => runCliInProcess(['publish', '--json'],
    { cwd: box.repo, env: { ...box.env, PULLBOARD_TIMING_FIXTURE_RED: '1' } });
  const red = await publish();
  assert.equal(red.status, 1, red.stderr + red.stdout);
  const runs = recorded(box);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, 'land');
  assert.equal(runs[0].green, false);
  assertMeasured(runs[0], box);
  const state = JSON.parse(readFileSync(join(box.repo, '.git', 'pullboard', 'publish.json'), 'utf8'));
  assert.equal(state.receipt, runs[0].id);
  assert.equal(state.red, box.head);
  assert.equal(box.git(box.repo, 'ls-remote', 'origin'), '', 'the private remote remains empty');
  const waiting = await publish();
  assert.equal(waiting.status, 0, waiting.stderr + waiting.stdout);
  assert.match(waiting.stdout, /"waiting":\s*true/u);
  assert.equal(recorded(box).length, 1, 'waiting for a new head creates no execution receipt');
});

test('a fresh main comparison survives checkout cleanup and cached comparisons add no invented time [C7,H16]', async t => {
  const box = timingProject(t);
  const source = `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
import {runGate} from './packages/gate/index.js';
import {runnerExecutionServices} from './packages/runners/index.js';
import {landingExecutionServices} from './packages/landing/index.js';
const executionServices={runners:runnerExecutionServices(),landing:landingExecutionServices()};
 import {compareMainFailures} from './packages/landing/index.js';
import {accountedFailures} from './packages/landing/index.js';
import {readGateReceipt,receiptStore} from './packages/gate/index.js'; import * as store from './packages/store/index.js'; import {openBoard} from './apps/lib/index.js';
const root=process.cwd(),config=JSON.parse(readFileSync('pullboard.json','utf8'));
const red=await runGate(root,config,{ executionServices,trustStamp:false,agent:'coordinator',stages:true}); assert.equal(red.isGreen,false);
assert.match(red.output,/# pullboard suite timing /); assert.equal(accountedFailures(red,root)?.length,1);
const ids=[]; const options={commit:${JSON.stringify(box.head)},detailed:true,onMeasuredReceipt:async id=>{
const receipt=readGateReceipt(receiptStore(root),id); assert.ok(receipt);
const board=openBoard('.git/pullboard/board.sqlite');
try {board.enginePorts.store.recordGateRun(board,{agentId:'coordinator',receipt,lane:'web'});} finally {store.closeBoard(board);}
ids.push(id);}};
const first=await compareMainFailures(root,red.profile,undefined,red.output,options);
assert.equal(first.unavailable,undefined); assert.equal(first.files[0].result,'red'); assert.equal(ids.length,1);
const again=await compareMainFailures(root,red.profile,undefined,red.output,options);
assert.equal(again.files[0].result,'red'); assert.equal(ids.length,1);
console.log(JSON.stringify({ids}));`;
  // Process-level: runs the fixture repo's own installed runtime as a separate node process.
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source],
    { cwd: box.repo, env: { ...box.env, PULLBOARD_TIMING_FIXTURE_RED: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const rows = recorded(box);
  assert.equal(rows.length, 1);
  const run = rows[0];
  assert.equal(run.kind, 'main-red');
  assert.equal(run.head, box.head);
  assert.equal(run.tree, box.tree);
  assert.equal(run.full, false);
  assert.ok(Number.isFinite(run.timing.compareMs) && run.timing.compareMs >= 0);
  assert.equal(run.timing.wallMs, run.timing.compareMs);
  assert.deepEqual([run.timing.selectionMs, run.timing.setupMs, run.timing.shards], [null, null, null]);
  assert.deepEqual(readGateReceipt(receiptStore(box.repo), run.id).timing, run.timing);
});

test('missing, duplicate and wrong-source suite observations never invent phase evidence [C7,H16]', () => {
  const source = { head: 'a'.repeat(40), tree: 'b'.repeat(40) }, id = randomUUID();
  const frame = { version: 1, id, ...source, node: process.versions.node, full: false, wallMs: 3,
    selectionMs: 1, setupMs: null, shards: [], compareMs: null };
  const line = formatSuiteTiming(frame);
  assert.ok(line);
  assert.equal(suiteTimingFromOutput('', id, source), null);
  assert.equal(suiteTimingFromOutput(line + line, id, source), null);
  assert.equal(suiteTimingFromOutput(line, randomUUID(), source), null);
  assert.equal(suiteTimingFromOutput(line, id, { ...source, head: 'c'.repeat(40) }), null);
  assert.equal(formatSuiteTiming({ ...frame, setupMs: -1 }), '');
  assert.equal(suiteTimingFromOutput(line, id, source).setupMs, null);
  const raw = [{ status: 1, output: 'original TAP account\n' + line,
    pipeline: [{ status: 1, output: 'component account\n' + line }] }];
  const projected = timingAccountingStages(raw, id, source);
  assert.equal(projected[0].output, 'original TAP account\n');
  assert.equal(projected[0].pipeline[0].output, 'component account\n');
  assert.equal(raw[0].output, 'original TAP account\n' + line, 'the raw evidence is not rewritten');
  for (const invalid of [line + line, line.replace(source.head, 'c'.repeat(40)),
    line.replace(id, randomUUID()), SUITE_TIMING_PREFIX + '{broken}\n', line + '# unexplained failure\n']) {
    const view = timingAccountingStages([{ status: 1, output: invalid }], id, source)[0].output;
    if (invalid.endsWith('# unexplained failure\n')) assert.equal(view, '# unexplained failure\n');
    else assert.equal(view, invalid, 'unproven diagnostics remain visible to strict failure accounting');
  }
});


test('collection accounting projects only canonical own diagnostics per component [C7,H16]', () => {
  const id = randomUUID(), source = { head: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const timing = formatSuiteTiming({ version: 1, id, ...source, full: false, node: '22.13.1', wallMs: 1,
    selectionMs: 0, setupMs: 0, shards: [], compareMs: null });
  const report = { id, scope: 'suite', shard: null, full: false,
    plannedFiles: ['test/b.test.js', 'test/a.test.js'], completedFiles: ['test/b.test.js', 'test/a.test.js'],
    complete: true, cleanupVerified: true };
  const collection = formatCollectionReport(report), account = 'original failure account\n';
  /** Project one component, preserving every unexplained byte for the strict TAP consumer. */
  const project = (output, options) => timingAccountingStages([{ status: 1, output }], id, source, options)[0].output;
  assert.equal(project(account + collection + timing), account, 'real producer order need not be sorted');
  assert.equal(project(account + collection), account + collection, 'collection alone supplies no source authentication');
  const incomplete = formatCollectionReport({ ...report, completedFiles: [], complete: false });
  assert.equal(project(account + incomplete + timing), account, 'diagnostic projection grants no completion authority');
  const otherId = randomUUID(), separate = formatCollectionReport({ ...report, id: otherId });
  assert.equal(project(account + separate + timing), account + separate, 'foreign collection nonce stays visible');
  assert.equal(project(account + separate + timing, { collectionId: otherId }), account,
    'collect-all supplies its distinct native nonce explicitly');
  for (const invalid of [collection + collection, COLLECTION_REPORT_PREFIX + '{broken}\n',
    COLLECTION_REPORT_PREFIX + JSON.stringify({ version: 1, ...report, extra: true }) + '\n',
    collection.replace('{', '{ '), formatCollectionReport({ ...report, shard: '1/1' }),
    formatCollectionReport({ ...report, plannedFiles: ['../outside.test.js'] }),
    formatCollectionReport({ ...report, completedFiles: [], complete: true })]) {
    assert.equal(project(account + invalid + timing), account + invalid,
      'malformed, duplicate and noncanonical collection bytes remain unexplained');
  }
  assert.equal(project(account + collection + separate + timing), account + separate,
    'another valid report is never silently erased');
  assert.equal(timingAccountingStages([{ status: 1, output: account + collection + timing }], id,
    { ...source, head: 'c'.repeat(40) })[0].output, account + collection + timing);
  const raw = [{ status: 1, output: account + collection + timing, pipeline: [
    { status: 1, output: account + collection }, { status: 0, output: collection + timing }] }];
  const original = structuredClone(raw), projected = timingAccountingStages(raw, id, source);
  assert.equal(projected[0].output, account);
  assert.equal(projected[0].pipeline[0].output, account + collection,
    'a different component cannot borrow the stage timing frame');
  assert.equal(projected[0].pipeline[1].output, '');
  assert.deepEqual(raw, original, 'raw stage and component evidence remains immutable');
});
