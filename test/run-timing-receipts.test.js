/** Actual native suite and gate receipts retain source-bound phases through board recording and replay [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyPackageFiles } from '../src/package-files.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChildAsync } from './fixture-child.js';
import { readGateReceipt, receiptFields, receiptStore } from '../src/gate-run-receipt.js';
import { formatSuiteTiming, suiteTimingFromOutput, SUITE_TIMING_PREFIX, timingAccountingStages } from '../src/run-timing.js';
import { RUN_TIMING_ENGINE } from '../src/run-timing-engine.js';
import { prepareEngineMove, applyEngineMove, appliedSequence } from '../src/engine.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { fixtureBoard } from './board-fixture.js';
import { eventMetrics } from '../bin/case-study/events.js';
import { commitFixtureFiles } from './package-copy-fixture.js';
import { randomUUID } from 'node:crypto';
import * as store from '../src/board.js';

/** Keep a real installed runtime but give the fixture its own two-file committed test universe. */
function timingProject(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node bin/run-tests.js', helpers.sandbox(), { withWorktree: false });
  const config = readFileSync(join(box.repo, 'pullboard.json'), 'utf8');
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const copied = copyPackageFiles(join(import.meta.dirname, '..'), box.repo);
  // Selective fixture: the installed runtime is real; shipped documentation tests are a different test universe.
  for (const file of copied) if (file !== 'package.json' && !/^(?:src|bin|packages)\//u.test(file)) rmSync(join(box.repo, file), { force: true });
  for (const file of copied) if (/\.test\.[cm]?js$/u.test(file)) rmSync(join(box.repo, file), { force: true });
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify({ ...JSON.parse(config), landingShards: 2,
    affectedTests: 'node bin/run-tests.js', flakes: { rerun: false } }));
  writeFileSync(join(box.repo, 'SPEC.md'), spec);
  writeFileSync(join(box.repo, 'test', 'one.test.js'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('first actual timing case [C7]',t=>{t.diagnostic('timing-leaf-node '+process.versions.node);assert.equal(process.env.PULLBOARD_TIMING_FIXTURE_RED,'0');});\n");
  writeFileSync(join(box.repo, 'test', 'two.test.js'), "import {test} from 'node:test'; test('second actual timing case [C7]',()=>{});\n");
  commitFixtureFiles(box, box.git(box.repo, 'ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard')
    .split('\0').filter(Boolean));
  const env = { ...box.env, PULLBOARD_TEST_REUSE: '0', PULLBOARD_TIMING_FIXTURE_RED: '0' };
  for (const key of ['NODE_TEST_CONTEXT', 'PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN',
    'PULLBOARD_LANDING_RUN', 'PULLBOARD_LANDING_SHARD', 'PULLBOARD_LANDING_COLLECTION_ID', 'PULLBOARD_TIMING_RUN_ID']) delete env[key];
  return { ...box, env, head: box.git(box.repo, 'rev-parse', 'HEAD'), tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') };
}

/** Read the native recorded history through its existing public board projection. */
function recorded(box) {
  const board = store.openBoardForRead(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  assert.ok(board);
  try { return store.gateRuns(board); } finally { store.closeBoard(board); }
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
  const run = async red => runFixtureChildAsync(process.execPath, ['bin/run-tests.js'],
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
  const board = store.openBoardForRead(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { assert.deepEqual(store.flakeQuarantines(board), [], 'direct-suite evidence cannot establish a quarantine'); }
  finally { store.closeBoard(board); }
  const filtered = await runFixtureChildAsync(process.execPath, ['bin/run-tests.js', '--test-skip-pattern=first'],
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
  const initial = store.openBoardForRead(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { importBoard(replica, exportBoard(initial)); } finally { store.closeBoard(initial); }
  const source = `import {runGate} from './src/gate.js'; import * as store from './src/board.js';
import {readFileSync} from 'node:fs'; import {readGateReceipt,receiptStore} from './src/gate-run-receipt.js';
const run=await runGate(process.cwd(),JSON.parse(readFileSync('pullboard.json','utf8')),{trustStamp:false,landing:true,agent:'coordinator'});
if(!run.isGreen) throw new Error(run.output);
const receipt=readGateReceipt(receiptStore(process.cwd()),run.receiptId);
const board=store.openBoard('.git/pullboard/board.sqlite');
try { store.recordGateRun(board,{agentId:'coordinator',receipt,lane:'web'}); } finally {store.closeBoard(board);}
console.log(run.output); console.log(JSON.stringify({receiptId:run.receiptId}));`;
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
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const receipt = readGateReceipt(receiptStore(box.repo), rows[0].id);
    const move = prepareEngineMove(board, 'recordGateRun', [{ agentId: 'coordinator', receipt, lane: 'web' }]);
    const sequence = appliedSequence(replica) + 1;
    const at = new Date().toISOString();
    assert.throws(() => applyEngineMove(replica, { ...move, engine: RUN_TIMING_ENGINE - 1 }, { sequence, at }),
      error => error.code === 'RELAY_MOVE', 'an older receiver cannot silently discard the actual phase evidence');
    assert.equal(appliedSequence(replica), sequence - 1);
    assert.equal(applyEngineMove(replica, move, { sequence, at }).error, undefined);
    assert.deepEqual(store.gateRuns(replica).find(row => row.id === receipt.id).timing, receipt.timing);
    const changed = structuredClone(rows[0]);
    changed.timing.wallMs += 1;
    assert.throws(() => store.recordGateRun(board, { agentId: 'coordinator', receipt: changed, lane: 'web' }),
      error => error.code === 'GATE_RUN_UNBOUND', 'altering an actual phase cannot reuse its native receipt');
  } finally { store.closeBoard(board); }
});

test('an all-reused direct invocation preserves a receipt without inventing a fresh full suite [C7,H16]', async t => {
  const box = timingProject(t);
  const env = { ...box.env, PULLBOARD_TEST_REUSE: '1' };
  const first = await runFixtureChildAsync(process.execPath, ['bin/run-tests.js'], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const second = await runFixtureChildAsync(process.execPath, ['bin/run-tests.js'], { cwd: box.repo, env, encoding: 'utf8' });
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
  const publish = () => runFixtureChildAsync(process.execPath, ['bin/pullboard.js', 'publish', '--json'],
    { cwd: box.repo, env: { ...box.env, PULLBOARD_TIMING_FIXTURE_RED: '1' }, encoding: 'utf8' });
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
import {runGate} from './src/gate.js'; import {compareMainFailures} from './src/main-red.js';
import {accountedFailures} from './src/land.js';
import {readGateReceipt,receiptStore} from './src/gate-run-receipt.js'; import * as store from './src/board.js';
const root=process.cwd(),config=JSON.parse(readFileSync('pullboard.json','utf8'));
const red=await runGate(root,config,{trustStamp:false,agent:'coordinator',stages:true}); assert.equal(red.isGreen,false);
assert.match(red.output,/# pullboard suite timing /); assert.equal(accountedFailures(red,root)?.length,1);
const ids=[]; const options={commit:${JSON.stringify(box.head)},detailed:true,onMeasuredReceipt:async id=>{
const receipt=readGateReceipt(receiptStore(root),id); assert.ok(receipt);
const board=store.openBoard('.git/pullboard/board.sqlite');
try {store.recordGateRun(board,{agentId:'coordinator',receipt,lane:'web'});} finally {store.closeBoard(board);}
ids.push(id);}};
const first=await compareMainFailures(root,red.profile,undefined,red.output,options);
assert.equal(first.unavailable,undefined); assert.equal(first.files[0].result,'red'); assert.equal(ids.length,1);
const again=await compareMainFailures(root,red.profile,undefined,red.output,options);
assert.equal(again.files[0].result,'red'); assert.equal(ids.length,1);
console.log(JSON.stringify({ids}));`;
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
