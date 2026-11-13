/** @pullboard-test-input apps/cli/src/io/cells-submit-checks.js packages/codemap/data/plan/cells.json packages/codemap/data/plan/path-map/kernel.json packages/codemap/data/plan/seed.json packages/codemap/data/plan/temporary-edges.json packages/codemap/data/plan/transition.json packages/gate/src/io/browser/guard.js */
import { observationCache } from '../../../../packages/codemap/src/io/cells/scripts/cache.js';
import { acceptedCutItems } from '../../../../packages/landing/tests/fixtures/plan.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
/** Submit checks use canonical immutable-source cell diagnostics [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  after,
  test,
} from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCuts } from '../../../../packages/codemap/src/io/cells/plan/cuts.js';
import { computePlan } from '../../../../packages/codemap/index.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';

test('submit cut mode catches a new target even when a cell has no historical cuts [C7,D3,CD64]', t => {
  const { root, put } = fixture(t), plan = computePlan(root);
  const early = plan.cells.find(cell => cell.paths.some(row => row[0] === 'src/refused.js'));
  const later = plan.cells.find(cell => cell.paths.some(row => row[0] === 'src/stats-flow.js'));
  assert.ok(later.order > early.order);
  assert.throws(() => checkCuts(root, plan, early.name), /no import-cut group/u,
    'the existing historical cut command keeps its original mode');
  assert.deepEqual(checkCuts(root, plan, early.name, { allLaterCells: true }), []);
  put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  const diagnostic = `${early.name} still imports later ${later.name}: src/refused.js -> src/stats-flow.js`;
  assert.ok(checkCuts(root, plan, early.name, { allLaterCells: true }).includes(diagnostic),
    'the actual new edge is named in the unchanged diagnostic format');
  put('packages/codemap/data/plan/temporary-edges.json', JSON.stringify({ version: 1, edges: [{ importer: 'src/refused.js',
    target: 'src/stats-flow.js', contractItem: 123, expires: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) }] }));
  assert.deepEqual(checkCuts(root, plan, early.name, { allLaterCells: true }), [],
    'existing temporary-edge behavior remains the default');
  assert.ok(checkCuts(root, plan, early.name, { allLaterCells: true, temporaryExceptions: false }).includes(diagnostic),
    'submit sees the real edge even when a declaration would otherwise exempt it');
  put('src/refused.js', "export async function load(name) { return import(name); }\n");
  assert.ok(checkCuts(root, plan, early.name, { allLaterCells: true, temporaryExceptions: false })
    .some(problem => problem.includes('cannot prove')), 'expanded cut mode never forgives unknown loaders');
});

test('submit cuts follow a declared root tool body so a stay cannot hide a later dependency [C7,D3,CD64]', t => {
  const { root, put } = fixture(t);
  put('bin/bridge.js', "import '../src/stats-flow.js'; export const bridge = true;\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'private root tool bridge');
  const plan = computePlan(root);
  const early = plan.cells.find(cell => cell.paths.some(row => row[0] === 'src/refused.js'));
  const later = plan.cells.find(cell => cell.paths.some(row => row[0] === 'src/stats-flow.js'));
  assert.ok(plan.stays.some(row => row.path === 'bin/bridge.js'), 'the helper is genuinely placed as a root tool');
  assert.deepEqual(checkCuts(root, plan, early.name, { allLaterCells: true, temporaryExceptions: false }), []);
  put('src/refused.js', "import '../bin/bridge.js'; export class Refused extends Error {}\n");
  const diagnostic = `${early.name} still imports later ${later.name}: bin/bridge.js -> src/stats-flow.js`;
  assert.ok(checkCuts(root, plan, early.name, { allLaterCells: true, temporaryExceptions: false }).includes(diagnostic),
    'the new upstream import cannot conceal the actual later edge behind an owned root-tool body');
  put('bin/bridge.js', 'export async function bridge(name) { return import(name); }\n');
  assert.ok(checkCuts(root, plan, early.name, { allLaterCells: true, temporaryExceptions: false })
    .some(problem => problem.includes('cannot prove cut through bin/bridge.js')), 'an unknown root-tool loader also refuses');
});

import { requireSubmitCells as inspectSubmit } from '../../index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../packages/codemap/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

// The accepted inventory is produced off-path by a background producer (#3533), so this file publishes each fixture
// main's inventory into one private machine home and hands it to the submit check as the producer's result would be.
const previousMachineHome = process.env.PULLBOARD_MACHINE_HOME, machineHome = privateFixtureFiles('cells-checks-machine-').root;
process.env.PULLBOARD_MACHINE_HOME = machineHome;
after(() => {
  if (previousMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previousMachineHome;
  rmSync(machineHome, { recursive: true, force: true });
});
/** The accepted inventory published for each fixture main, by main commit. */
const published = new Map();
/** The real submit check with the inventory its producer published for `main`. */
const preflight = (root, main, commit, item, services) => inspectSubmit(root, main, commit, item, services && { ...services, acceptedArtifact: services.acceptedArtifact ?? published.get(main) });

/** Bind real higher-controller services for every immutable fixture inspection. */
const requireSubmitCells = (...args) => preflight(...args, { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache, readCutItems: (main, root) => acceptedCutItems(root, main), cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });

/** Commit the actual small plan and complete canonical baseline, with no production-source substitution. */
async function plannedFixture(t, prepare = () => {}) {
  const box = fixture(t);
  prepare(box);
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'plan actual fixture');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn })), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'snapshot actual fixture debt');
  const main = git(box.root, 'rev-parse', 'HEAD').trim();
  const trunk = git(box.root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const artifact = await warmAcceptedCells(box.root, main, { withCheckout: withMainCheckout, withLock: withFileLock, trunk });
  assert.equal(artifact.available, true, 'the producer published the accepted inventory of main');
  published.set(main, artifact);
  return { ...box, main, item: { item_title: 'Cells move 1/1: fixture moves behind shims', item_frozen: JSON.stringify({ criterion: 'Preserve actual cell boundaries.' }) } };
}

/** Commit the exact candidate the real immutable-snapshot preflight will inspect. */
function commitCandidate(box) {
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'candidate composition');
  return git(box.root, 'rev-parse', 'HEAD').trim();
}

test('submit accepts unchanged scheduled debt but refuses an unplaced committed source before executing it [C7,D3,CD64]', async t => {
  const box = await plannedFixture(t);
  const clean = await requireSubmitCells(box.root, box.main, box.main, box.item);
  assert.deepEqual(clean.problems, []);
  box.put('src/new-unsafe.js', 'throw new Error("candidate module must never execute");\n');
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /no cells-plan entry: src\/new-unsafe.js/u);
});

test('submit names a new later edge even when candidate metadata declares it temporary [C7,D3,CD64]', async t => {
  const box = await plannedFixture(t);
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  const commit = commitCandidate(box);
  await assert.rejects(requireSubmitCells(box.root, box.main, commit, box.item), /kernel --cuts: kernel still imports later stats: src\/refused.js -> src\/stats-flow.js/u);
  box.put('packages/codemap/data/plan/temporary-edges.json', JSON.stringify({ version: 1, edges: [{ importer: 'src/refused.js', target: 'src/stats-flow.js', contractItem: 123,
    expires: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) }] }));
  const declared = commitCandidate(box);
  await assert.rejects(requireSubmitCells(box.root, box.main, declared, box.item), /frozen criterion does not name exact edge/u);
  const authorized = { item_title: box.item.item_title, item_frozen: JSON.stringify({ criterion: 'Temporary src/refused.js -> src/stats-flow.js under contract 123.' }) };
  await assert.rejects(requireSubmitCells(box.root, box.main, declared, authorized), /kernel --cuts: kernel still imports later stats/u,
    'exact metadata authority never exempts the actual new later-cell edge');
});

test('submit keeps accepted placement authority when a candidate drops a row into stays or changes cell order [C7,D3,CD64]', async t => {
  const box = await plannedFixture(t), plan = readPlan(box.root);
  const early = plan.cells.find(cell => cell.name === 'kernel');
  const row = early.paths.shift();
  plan.stays.push({ path: row[0], reason: 'forged candidate exemption' });
  writePlan(box.root, plan);
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /accepted row src\/refused.js disappeared/u);
  early.paths.push(row);
  early.order = 999;
  writePlan(box.root, plan);
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /accepted cell kernel identity\/order\/front door changed/u);
});

test('submit compares lints with accepted allowances even if a candidate rewrites its own baseline [C7,D3,CD64]', async t => {
  const box = await plannedFixture(t);
  box.put('src/refused.js', 'export class Refused extends Error {}\n' + '\n'.repeat(1501));
  const report = cellLintReport(box.root, { importsIn, commonJsIn });
  writeCellLintBaseline(box.root, cellLintBaseline(report));
  assert.ok(report.metrics.fileSize.findings.some(row => row.key === 'src/refused.js' && row.count > 1000), 'the actual source crosses the unchanged hard 1500-line cap');
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /cell lint fileSize:src\/refused.js/u,
    'the candidate baseline cannot authorize its own hard-cap rise');
});

test('submit accepts a real clean move and keeps an existing temporary edge as unchanged debt [C7,D3,CD64]', async t => {
  const box = await plannedFixture(t, box => {
    box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
    box.put('packages/codemap/data/plan/temporary-edges.json', JSON.stringify({ version: 1, edges: [{ importer: 'src/refused.js', target: 'src/stats-flow.js', contractItem: 123,
      expires: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) }] }));
    git(box.root, 'add', '-A'); git(box.root, 'commit', '-q', '-m', 'actual preexisting temporary edge');
  });
  box.put('bin/tool.js', "import '../src/cli.js'; // unchanged runtime dependency\n");
  assert.deepEqual((await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item)).problems, [],
    'temporary exceptions are disabled in both snapshots and the old exact edge is still equal debt');
  const clean = await plannedFixture(t);
  clean.put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
  clean.put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
  clean.put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
  clean.put('apps/cli/index.js', "import '../../src/cli.js';\n");
  clean.put('path-map.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/logic/refused.js' }));
  assert.deepEqual((await requireSubmitCells(clean.root, clean.main, commitCandidate(clean), clean.item)).problems, [],
    'the actual reachable named front door and body satisfy the canonical move check');
});

/** Move the real kernel body through its named front door and a committed per-cell path-map shard. */
function moveFixtureKernel(box, body) {
  box.put('packages/kernel/src/logic/refused.js', body);
  box.put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
  box.put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
  box.put('apps/cli/index.js', "import '../../src/cli.js';\n");
  box.put('packages/codemap/data/plan/path-map/kernel.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/logic/refused.js' }));
}

test('submit preserves an existing cut across a real importer relocation [C7,D3,CD64]', async t => {
  const box = await plannedFixture(t, box => {
    box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  });
  moveFixtureKernel(box, "import '../../../../src/stats-flow.js'; export class Refused extends Error {}\n");
  const result = await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item);
  assert.deepEqual(result.problems, [], 'the same actual dependency is inherited under its committed moved path');
  // Submit no longer lists the accepted cut backlog (it belongs to the main audit: 7a6b37bef3, cutDeltaProblems).
  assert.deepEqual(result.existingCuts, [], 'the accepted backlog is not relisted, and the relocated edge adds nothing to it');
});

test('submit still refuses a genuinely new cut after an importer relocation [C7,D3,CD64]', async t => {
  const box = await plannedFixture(t);
  moveFixtureKernel(box, "import '../../../../src/stats-flow.js'; export class Refused extends Error {}\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item),
    /kernel --cuts: kernel still imports later stats: packages\/kernel\/src\/logic\/refused\.js -> src\/stats-flow\.js/u,
    'a rename cannot lend an old allowance to a new dependency');
});

test('submit ignores candidate checker code and refuses a forged overlapping ownership root [C7,D3,CD64]', async t => {
  const box = await plannedFixture(t, box => {
    box.put('packages/codemap/src/io/cells/plan/cuts.js', 'export const fixtureChecker = true;\n');
    git(box.root, 'add', '-A'); git(box.root, 'commit', '-q', '-m', 'private checker source');
  });
  box.put('packages/codemap/src/io/cells/plan/cuts.js', 'throw new Error("candidate checker execution is forbidden");\n');
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /kernel --cuts: kernel still imports later stats/u);
  const plan = readPlan(box.root);
  plan.cells.unshift({ order: 44, name: 'forged', kind: 'package', root: 'packages', frontDoor: 'packages/index.js', paths: [], reexports: [], imports: [], cuts: [] });
  writePlan(box.root, plan);
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /overlapping cell root/u,
    'a new cell cannot shadow all accepted package owners');
});

test('submit requires real controller services before reading any input [C7,D3]', async t => {
  const box = fixture(t), commit = git(box.root, 'rev-parse', 'HEAD').trim();
  await assert.rejects(preflight(box.root, commit, commit, {}), /canonical parser and cache services are required/u);
  // The cell object scope itself needs an actual repository before anything else (#2711).
  await assert.rejects(preflight(null, null, null, null), /cells object scope needs a repository and action/u);
});

import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { lex } from '../../../../packages/kernel/index.js';
import { bindingReadsForModules } from '../../../../packages/codemap/index.js';
import { cachedBindingMetadata } from '../../../../packages/codemap/index.js';
import { exportReachability } from '../../../../packages/codemap/src/io/cell/lint/exports.js';
import { withBindingReadCache } from '../../../../packages/codemap/index.js';
import { foreignNodeOptions } from '../../../../packages/gate/index.js';

/** Count actual compiler children, preserving every successful V8 observation. */
function bindingCompilerCalls(t, observed = {}) {
  const original = childProcess.spawnSync;
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', (...args) => {
    const flags = args[1];
    if (args[0] === process.execPath && Array.isArray(flags) && flags.includes('--experimental-vm-modules')) {
      calls++;
      const code = flags[flags.indexOf('-e') + 1] ?? '';
      const kind = code.includes('moduleRequests') ? 'imports' : 'bindings';
      observed[kind] = (observed[kind] ?? 0) + 1;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => calls;
}

/** The same real imported capability and original-offset probe body the fixture analyzer supplies. */
function bindingModules() {
  const prefix = "import { join } from 'node:path';\n";
  const source = prefix + "const actual = join(root, 'state.json');\n";
  return [{ file: 'binding-cache.js', source, body: ' '.repeat(prefix.length - 1) + '\n' + lex(source).code.slice(prefix.length), bindings: [{ local: 'join' }] }];
}

const bindingCacheEligible = () => !foreignNodeOptions(process.env.NODE_OPTIONS);

test('one eligible binding census reuses real probes and returns independent Maps for exact inputs [C7,D3]', t => {
  const calls = bindingCompilerCalls(t), modules = bindingModules();
  withBindingReadCache(() => {
    const first = bindingReadsForModules(modules), expected = structuredClone(first);
    assert.ok(first.get('binding-cache.js').get('join').reads.length > 0);
    first.get('binding-cache.js').get('join').reads.push(-1); first.set('forged', new Map());
    assert.deepEqual(bindingReadsForModules(modules), expected);
    assert.equal(calls(), 1, 'the hit reuses an actual real compiler observation');
    const changed = bindingModules(); changed[0].source = changed[0].source.replace('state.json', 'other.json');
    bindingReadsForModules(changed);
    assert.equal(calls(), 2, 'different actual source bytes compile again');
    const body = bindingModules(); body[0].body = ' '.repeat(body[0].body.length);
    assert.equal(bindingReadsForModules(body).get('binding-cache.js').get('join').reads.length, 0);
    assert.equal(calls(), 3, 'a different probe body is a different computation');
  }, { eligible: bindingCacheEligible });
  bindingReadsForModules(modules);
  assert.equal(calls(), 4, 'the completed census cannot lend its result to another caller');
});

test('lexical metadata reuse is isolated and keyed by source and resolved edges [C7,D3]', () => {
  const observations = new Map(), edges = [{ specifier: './a.js', target: 'a.js' }];
  let calls = 0;
  const run = (source, rows) => cachedBindingMetadata(source, rows, () => ({ exports: new Map([['x', ++calls]]) }));
  withBindingReadCache(() => {
    const first = run('source', edges); first.exports.set('forged', 1);
    assert.deepEqual([...run('source', edges).exports], [['x', 1]]);
    assert.equal(run('changed', edges).exports.get('x'), 2);
    assert.equal(run('source', [{ ...edges[0], target: 'b.js' }]).exports.get('x'), 3);
  }, { eligible: () => true, observations });
  withBindingReadCache(() => assert.equal(run('source', edges).exports.get('x'), 1), { eligible: () => true, observations });
  assert.equal(calls, 3);
});

test('a newly reachable unchanged module reuses its cold census observation [C7,D3]', t => {
  const calls = bindingCompilerCalls(t), observations = new Map();
  const files = new Map([['a.js', Buffer.from("import { value } from './b.js'; export const a = value;\n")],
    ['b.js', Buffer.from('export const value = 1;\n')]]);
  const edges = new Map([['a.js', [{ specifier: './b.js', target: 'b.js' }]], ['b.js', []]]);
  withBindingReadCache(() => exportReachability(files, edges, new Set(['a.js'])),
    { eligible: () => true, observations, warmAll: true });
  const cold = calls();
  let warm;
  withBindingReadCache(() => { warm = exportReachability(files, edges, new Set(['a.js', 'b.js'])); },
    { eligible: () => true, observations, warmAll: true });
  assert.equal(calls(), cold, 'new reach does not compile an unchanged module');
  assert.deepEqual(warm, exportReachability(files, edges, new Set(['a.js', 'b.js'])), 'reachability diagnostics remain canonical');
});

test('real compiler observations survive a checked same-main census only [C7,D3]', t => {
  const { root } = fixture(t), calls = bindingCompilerCalls(t);
  // The checker's identity is the bytes of its code files (#2601), so the key names real files of this tool.
  const tool = path => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
  const key = { code: [tool('packages/codemap/src/io/cells/scripts/cache.js')], config: { acceptedMain: 'main', preloads: [] } };
  const cache = observationCache(root, key, () => true), modules = bindingModules();
  withBindingReadCache(() => bindingReadsForModules(modules), { eligible: () => true, observations: cache.values });
  assert.equal(calls(), 1);
  cache.commit();
  const restored = observationCache(root, key, () => true);
  const reconstructed = structuredClone(modules);
  reconstructed[0].source = JSON.parse(JSON.stringify(reconstructed[0].source));
  reconstructed[0].body = JSON.parse(JSON.stringify(reconstructed[0].body));
  withBindingReadCache(() => bindingReadsForModules(reconstructed), { eligible: () => true, observations: restored.values });
  assert.equal(calls(), 1, 'a later process scope reuses equal reconstructed input values');
  const changed = observationCache(root, { ...key, code: [tool('apps/cli/src/io/cells-submit-checks.js')] }, () => true);
  withBindingReadCache(() => bindingReadsForModules(modules), { eligible: () => true, observations: changed.values });
  assert.equal(calls(), 2, 'checker identity invalidates the durable observations');
  const preloadChanged = observationCache(root, { ...key, config: { ...key.config, preloads: ['new bytes'] } }, () => true);
  withBindingReadCache(() => bindingReadsForModules(modules), { eligible: () => true, observations: preloadChanged.values });
  assert.equal(calls(), 3, 'changed preload identity invalidates durable observations');
  const ineligible = observationCache(root, key, () => false);
  assert.equal(ineligible.values.size, 0, 'untrusted runtime context cannot read prior observations');
});

test('changed module recompiles without probing unchanged modules in one eligible census [C7,D3]', t => {
  const calls = bindingCompilerCalls(t), first = bindingModules(), second = bindingModules();
  second[0].file = 'other.js';
  withBindingReadCache(() => {
    const old = bindingReadsForModules([...first, ...second]);
    assert.equal(calls(), 1);
    const changed = structuredClone(second);
    changed[0].source = changed[0].source.replace('state.json', 'other.json');
    const next = bindingReadsForModules([...first, ...changed]);
    assert.equal(calls(), 2);
    assert.deepEqual(next.get(first[0].file), old.get(first[0].file));
  }, { eligible: bindingCacheEligible });
});

test('foreign runtime options invalidate binding reuse inside the current census [C7,D3]', t => {
  const calls = bindingCompilerCalls(t), before = process.env.NODE_OPTIONS;
  try {
    withBindingReadCache(() => {
      bindingReadsForModules(bindingModules()); bindingReadsForModules(bindingModules());
      assert.equal(calls(), 1);
      process.env.NODE_OPTIONS = '--no-warnings';
      bindingReadsForModules(bindingModules()); bindingReadsForModules(bindingModules());
      assert.equal(calls(), 3, 'the canonical foreign-options classifier forces actual fresh compilers');
    }, { eligible: bindingCacheEligible });
  } finally { if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before; }
});

test('binding compiler failures never become cached authority [C7,D3]', t => {
  const original = childProcess.spawnSync;
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', (...args) => ++calls === 1
    ? { status: 1, stderr: 'private binding compiler transport failed' } : original(...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  withBindingReadCache(() => {
    assert.throws(() => bindingReadsForModules(bindingModules()), /private binding compiler transport failed/u);
    assert.ok(bindingReadsForModules(bindingModules()).get('binding-cache.js').get('join').reads.length > 0);
    bindingReadsForModules(bindingModules());
    assert.equal(calls, 2, 'only the later genuine successful compiler result is reusable');
  }, { eligible: bindingCacheEligible });
});

test('accessor arrays and generator callers retain ordinary real binding computation [C7,D3]', t => {
  const calls = bindingCompilerCalls(t), modules = bindingModules(), row = modules[0];
  Object.defineProperty(modules, '0', { enumerable: true, configurable: true, get: () => row });
  withBindingReadCache(() => {
    assert.deepEqual(bindingReadsForModules(modules), bindingReadsForModules(modules));
    assert.equal(calls(), 2, 'an accessor-backed array slot never supplies reusable identity');
    const generator = function* () { yield row; };
    assert.deepEqual(bindingReadsForModules(generator()), bindingReadsForModules(generator()));
    assert.equal(calls(), 4, 'existing generator callers are consumed normally, never guessed into an array cache');
  }, { eligible: bindingCacheEligible });
});

test('eligible runtime context changes require a fresh real binding compiler observation [C7,D3]', t => {
  const calls = bindingCompilerCalls(t), before = process.env.NODE_OPTIONS;
  const owned = new URL('../../../../packages/gate/src/io/browser/guard.js', import.meta.url).href;
  const next = `${before ?? ''} --import=${owned}`.trim();
  try {
    withBindingReadCache(() => {
      bindingReadsForModules(bindingModules());
      assert.equal(calls(), 1);
      process.env.NODE_OPTIONS = next;
      assert.equal(bindingCacheEligible(), true, 'the actual owned browser preload remains canonically eligible');
      bindingReadsForModules(bindingModules()); bindingReadsForModules(bindingModules());
      assert.equal(calls(), 2, 'a changed eligible material context compiles afresh, then may reuse only that result');
    }, { eligible: bindingCacheEligible });
  } finally { if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before; }
});

/** The refusal text a candidate draws, or an empty string when submit accepts it. */
async function refusal(promise) {
  try { await promise; return ''; } catch (error) { return error.message; }
}

