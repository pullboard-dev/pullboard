import { inventoryCache } from '../bin/cells-inventory-cache.js';
import { observationCache } from '../bin/cells-inventory-cache.js';
import { cellInventory } from '../packages/codemap/index.js';
import { acceptedCutItems } from './cells-plan-fixture.js';
import { withImportParseCache } from '../src/module-import-cache.js';
/** Submit checks use canonical immutable-source cell diagnostics [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { checkCuts } from '../bin/cells-plan-cuts.js';
import { computePlan } from '../bin/cells-plan.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';

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
  put('bin/cells-plan/temporary-edges.json', JSON.stringify({ version: 1, edges: [{ importer: 'src/refused.js',
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

import { requireSubmitCells as preflight } from '../bin/cells-submit-checks.js';
import { touchedCells } from '../bin/cells-submit-checks.js';
import { withMainCheckout } from '../packages/landing/index.js';
import { writePlan } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { cellLintReport } from '../packages/codemap/index.js';
import { cellLintBaseline } from '../packages/codemap/index.js';
import { writeCellLintBaseline } from '../packages/codemap/index.js';
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';

/** Bind real higher-controller services for every immutable fixture inspection. */
const requireSubmitCells = (...args) => preflight(...args, { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache, readCutItems: (main, root) => acceptedCutItems(root, main), cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });

/** Commit the actual small plan and complete canonical baseline, with no production-source substitution. */
function plannedFixture(t, prepare = () => {}) {
  const box = fixture(t);
  prepare(box);
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'plan actual fixture');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn })), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'snapshot actual fixture debt');
  return { ...box, main: git(box.root, 'rev-parse', 'HEAD').trim(), item: { item_frozen: JSON.stringify({ criterion: 'Preserve actual cell boundaries.' }) } };
}

/** Commit the exact candidate the real immutable-snapshot preflight will inspect. */
function commitCandidate(box) {
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'candidate composition');
  return git(box.root, 'rev-parse', 'HEAD').trim();
}

test('submit accepts unchanged scheduled debt but refuses an unplaced committed source before executing it [C7,D3,CD64]', async t => {
  const box = plannedFixture(t);
  const clean = await requireSubmitCells(box.root, box.main, box.main, box.item);
  assert.deepEqual(clean.problems, []);
  box.put('src/new-unsafe.js', 'throw new Error("candidate module must never execute");\n');
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /unplaced src\/new-unsafe.js/u);
});

test('submit names a new later edge even when candidate metadata declares it temporary [C7,D3,CD64]', async t => {
  const box = plannedFixture(t);
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  const commit = commitCandidate(box);
  await assert.rejects(requireSubmitCells(box.root, box.main, commit, box.item), /kernel --cuts: kernel still imports later stats: src\/refused.js -> src\/stats-flow.js/u);
  box.put('bin/cells-plan/temporary-edges.json', JSON.stringify({ version: 1, edges: [{ importer: 'src/refused.js', target: 'src/stats-flow.js', contractItem: 123,
    expires: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) }] }));
  const declared = commitCandidate(box);
  await assert.rejects(requireSubmitCells(box.root, box.main, declared, box.item), /frozen criterion does not name exact edge/u);
  const authorized = { item_frozen: JSON.stringify({ criterion: 'Temporary src/refused.js -> src/stats-flow.js under contract 123.' }) };
  await assert.rejects(requireSubmitCells(box.root, box.main, declared, authorized), /kernel --cuts: kernel still imports later stats/u,
    'exact metadata authority never exempts the actual new later-cell edge');
});

test('submit keeps accepted placement authority when a candidate drops a row into stays or changes cell order [C7,D3,CD64]', async t => {
  const box = plannedFixture(t), plan = readPlan(box.root);
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
  const box = plannedFixture(t);
  box.put('src/refused.js', 'export class Refused extends Error {}\n' + '\n'.repeat(1501));
  const report = cellLintReport(box.root, { importsIn, commonJsIn });
  writeCellLintBaseline(box.root, cellLintBaseline(report));
  assert.ok(report.metrics.fileSize.findings.some(row => row.key === 'src/refused.js' && row.count > 1000), 'the actual source crosses the unchanged hard 1500-line cap');
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /cell lint fileSize:src\/refused.js/u,
    'the candidate baseline cannot authorize its own hard-cap rise');
});


test('submit accepts a real clean move and keeps an existing temporary edge as unchanged debt [C7,D3,CD64]', async t => {
  const box = plannedFixture(t, box => {
    box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
    box.put('bin/cells-plan/temporary-edges.json', JSON.stringify({ version: 1, edges: [{ importer: 'src/refused.js', target: 'src/stats-flow.js', contractItem: 123,
      expires: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) }] }));
    git(box.root, 'add', '-A'); git(box.root, 'commit', '-q', '-m', 'actual preexisting temporary edge');
  });
  box.put('bin/tool.js', "import '../src/cli.js'; // unchanged runtime dependency\n");
  assert.deepEqual((await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item)).problems, [],
    'temporary exceptions are disabled in both snapshots and the old exact edge is still equal debt');
  const clean = plannedFixture(t);
  clean.put('packages/kernel/src/core/refused.js', 'export class Refused extends Error {}\n');
  clean.put('packages/kernel/index.js', "export { Refused } from './src/core/refused.js';\n");
  clean.put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
  clean.put('apps/cli/index.js', "import '../../src/cli.js';\n");
  clean.put('path-map.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/core/refused.js' }));
  assert.deepEqual((await requireSubmitCells(clean.root, clean.main, commitCandidate(clean), clean.item)).problems, [],
    'the actual reachable named front door and body satisfy the canonical move check');
});

/** Move the real kernel body through its named front door and a committed per-cell path-map shard. */
function moveFixtureKernel(box, body) {
  box.put('packages/kernel/src/core/refused.js', body);
  box.put('packages/kernel/index.js', "export { Refused } from './src/core/refused.js';\n");
  box.put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
  box.put('apps/cli/index.js', "import '../../src/cli.js';\n");
  box.put('bin/cells-plan/path-map/kernel.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/core/refused.js' }));
}

test('submit preserves an existing cut across a real importer relocation [C7,D3,CD64]', async t => {
  const box = plannedFixture(t, box => {
    box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  });
  moveFixtureKernel(box, "import '../../../../src/stats-flow.js'; export class Refused extends Error {}\n");
  const result = await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item);
  assert.deepEqual(result.problems, [], 'the same actual dependency is inherited under its committed moved path');
  assert.ok(result.existingCuts.some(problem => problem.includes('src/refused.js -> src/stats-flow.js')),
    'the original cut evidence remains readable in its original source namespace');
});

test('submit still refuses a genuinely new cut after an importer relocation [C7,D3,CD64]', async t => {
  const box = plannedFixture(t);
  moveFixtureKernel(box, "import '../../../../src/stats-flow.js'; export class Refused extends Error {}\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item),
    /kernel --cuts: kernel still imports later stats: packages\/kernel\/src\/core\/refused\.js -> src\/stats-flow\.js/u,
    'a rename cannot lend an old allowance to a new dependency');
});

test('submit ignores candidate checker code and refuses a forged overlapping ownership root [C7,D3,CD64]', async t => {
  const box = plannedFixture(t, box => {
    box.put('bin/cells-plan-cuts.js', 'export const fixtureChecker = true;\n');
    git(box.root, 'add', '-A'); git(box.root, 'commit', '-q', '-m', 'private checker source');
  });
  box.put('bin/cells-plan-cuts.js', 'throw new Error("candidate checker execution is forbidden");\n');
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /kernel --cuts: kernel still imports later stats/u);
  const plan = readPlan(box.root);
  plan.cells.unshift({ order: 44, name: 'forged', kind: 'package', root: 'packages', frontDoor: 'packages/index.js', paths: [], reexports: [], imports: [], cuts: [] });
  writePlan(box.root, plan);
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /overlapping cell root/u,
    'a new cell cannot shadow all accepted package owners');
});

test('submit requires real controller services before reading any input [C7,D3]', async () => {
  await assert.rejects(preflight(null, null, null, null), /canonical checkout and parser services are required/u);
});

import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { lex } from '../packages/kernel/index.js';
import { bindingReadsForModules } from '../packages/codemap/index.js';
import { fixtureSourceEdits } from '../bin/cells-move-fixtures.js';
import { cachedBindingMetadata } from '../packages/codemap/src/shell/cell-binding-uses.js';
import { exportReachability } from '../packages/codemap/src/shell/cell-lint-exports.js';
import { withBindingReadCache } from '../packages/codemap/index.js';
import { foreignNodeOptions } from '../src/test-isolation.js';

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
  const key = { checkDigest: 'checker', config: { acceptedMain: 'main', preloads: [] } };
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
  const changed = observationCache(root, { ...key, checkDigest: 'changed' }, () => true);
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
  const owned = new URL('../packages/gate/src/shell/browser-slot-guard.js', import.meta.url).href;
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

test('cached and canonically bypassed complete submit diagnostics agree with actual parser and binding work [C7,D3,CD64]', async t => {
  const box = plannedFixture(t, box => {
    box.put('packages/kernel/src/core/refused.js', 'export class Refused extends Error {}\n');
    box.put('packages/kernel/index.js', "export { Refused } from './src/core/refused.js';\n");
    box.put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
    box.put('path-map.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/core/refused.js' }));
    box.put('test/reader.test.js', "import { readFileSync } from 'node:fs'; import { join } from 'node:path';\nexport function observe(root) { return readFileSync(join(root, 'src/refused.js'), 'utf8'); }\n");
    git(box.root, 'add', '-A'); git(box.root, 'commit', '-q', '-m', 'actual existing fixture reader obligation');
  });
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  const candidate = commitCandidate(box), observed = {}, calls = bindingCompilerCalls(t, observed);
  let requested = 0, computed = 0;
  const run = item => preflight(box.root, box.main, candidate, item, { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache,
    readCutItems: (main, root) => acceptedCutItems(root, main), cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS),
    onBindingProbe: row => { requested += row.requested; computed += row.computed; } });
  let cached;
  try { await run(box.item); }
  catch (error) { cached = error; }
  assert.match(cached?.message ?? '', /kernel --cuts: kernel still imports later stats/u);
  const first = { ...observed, requested, computed }, before = process.env.NODE_OPTIONS;
  observed.imports = 0; observed.bindings = 0;
  requested = 0; computed = 0;
  const changedCriterion = { item_frozen: JSON.stringify({ criterion: 'Preserve actual cell boundaries with another criterion.' }) };
  await assert.rejects(run(changedCriterion), /kernel --cuts: kernel still imports later stats/u);
  assert.equal(computed, 0, 'a refused candidate still preserves complete binding observations for a later criterion');
  observed.imports = 0; observed.bindings = 0;
  requested = 0; computed = 0;
  try {
    process.env.NODE_OPTIONS = '--no-warnings';
    assert.equal(bindingCacheEligible(), false);
    let uncached;
    try { await run(box.item); }
    catch (error) { uncached = error; }
    assert.equal(uncached?.message, cached.message, 'the exact full diagnostics do not change when canonical policy bypasses both caches');
    assert.ok(observed.imports > first.imports, 'actual submit entry bypasses import-parser reuse');
    assert.ok(first.requested > first.computed, 'eligible actual submit reuses binding probes within the census');
    assert.equal(computed, requested, 'canonical bypass recompiles every requested binding probe');
    assert.ok(computed > first.computed, 'actual submit entry bypasses repeated binding-probe reuse');
    assert.ok(calls() > 0);
  } finally { if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before; }
});

/** Exercise the actual writer's 100-order filename, not an invented alternate reader spelling. */
test('submit reads canonical 100-order shards and refuses alternate shard identities [C7,D3]', async t => {
  const box = plannedFixture(t), plan = readPlan(box.root);
  plan.cells.find(cell => cell.name === 'kernel').order = 100;
  writePlan(box.root, plan);
  const commit = commitCandidate(box);
  const index = JSON.parse(git(box.root, 'show', `${commit}:bin/cells-plan.json`));
  const row = index.cells.find(cell => cell.name === 'kernel');
  assert.equal(row.file, 'bin/cells-plan/100-kernel.json');
  await assert.rejects(requireSubmitCells(box.root, box.main, commit, box.item), /accepted cell kernel identity\/order\/front door changed/u,
    'the canonical writer filename reaches the original ownership/order guard');
  const original = git(box.root, 'show', `${commit}:${row.file}`);
  for (const alias of ['bin/cells-plan/0100-kernel.json', 'bin/cells-plan/100-git.json']) {
    row.file = alias;
    box.put(alias, original);
    box.put('bin/cells-plan.json', JSON.stringify(index));
    const forged = commitCandidate(box);
    assert.equal(git(box.root, 'show', `${forged}:${alias}`), original, 'the alternate really exists with the same committed body');
    await assert.rejects(requireSubmitCells(box.root, box.main, forged, box.item), /CELLS_PLAN_SHARD/u,
      'an extra zero or mismatched name cannot change canonical shard identity');
  }
});


test('scheduled rows stay unmoved while mapped cells retain real missing-body checks [C7,D3,CD64]', async t => {
  const box = plannedFixture(t);
  const plan = readPlan(box.root), kernel = plan.cells.find(cell => cell.name === 'kernel');
  box.put('src/new.css', 'body { color: red; }\n');
  kernel.paths.push(['src/new.css', 'packages/kernel/src/shell/new.css', 'rule']);
  writePlan(box.root, plan);
  assert.deepEqual((await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item)).problems, [],
    'a scheduled asset in an unmoved cell does not require its future body');
  box.put('path-map.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/core/refused.js' }));
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /kernel --moved: missing/u,
    'an actual mapped move still refuses missing implementation bytes');
});

test('outside-cell changes do not widen touched cells but still refuse unplaced source [C7,D3,CD64]', async t => {
  const box = plannedFixture(t);
  box.put('test/ordinary.test.js', '// real outside-cell test change\n');
  const result = await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item);
  assert.deepEqual(result.cells, []);
  assert.deepEqual(result.problems, []);
  box.put('src/unplanned.js', 'export const value = 1;\n');
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /unplaced src\/unplanned.js/u);
});

/** The refusal text a candidate draws, or an empty string when submit accepts it. */
async function refusal(promise) {
  try { await promise; return ''; } catch (error) { return error.message; }
}

test('submit refuses deleting a module a test names inside a generated script, never for a comment or prose mention [C7,D3]', async t => {
  for (const form of [() => './src/doomed.js', () => '${ROOT}/src/doomed.js', root => join(root, 'src/doomed.js'), root => pathToFileURL(join(root, 'src/doomed.js')).href]) {
    const box = plannedFixture(t, fixture => {
      fixture.put('src/doomed.js', "import { stats } from './stats.js';\nexport const doomed = stats;\n");
      fixture.put('src/quiet.js', "import { stats } from './stats.js';\nexport const quiet = stats;\n");
      fixture.put('test/child.test.js', `const script = \`import('${form(fixture.root)}').then(m => m.doomed);\`;\n// src/quiet.js once held the quiet value\nconst note = 'the old src/quiet.js held the quiet value';\nexport { script, note };\n`);
    });
    const remove = file => { git(box.root, 'rm', '-q', '--', file); writePlan(box.root, computePlan(box.root)); };
    remove('src/doomed.js');
    const named = await refusal(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item));
    assert.match(named, /test\/child\.test\.js:1 names deleted src\/doomed\.js inside a string/u);
    assert.doesNotMatch(named, /stale/u, 'the plan follows the deletion, so the string mention alone refuses');
    git(box.root, 'checkout', '-q', box.main, '--', 'src/doomed.js', 'bin');
    remove('src/quiet.js');
    assert.doesNotMatch(await refusal(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item)), /names deleted/u,
      'a comment or prose mention never holds a deletion');
  }
});

test('submit cell receipt reuses exact input and invalidates changed cut authority [C7,D3,CD64]', async t => {
  const box = plannedFixture(t);
  let checkouts = 0, rows = [];
  const services = { parsers: { importsIn, commonJsIn }, withImportParseCache,
    cacheEligible: () => true, readCutItems: () => rows,
    withMainCheckout: (root, commit, run) => { checkouts++; return withMainCheckout(root, commit, run); } };
  const first = await preflight(box.root, box.main, box.main, box.item, services);
  assert.deepEqual(first.problems, []);
  const afterFirst = checkouts;
  const second = await preflight(box.root, box.main, box.main, box.item, services);
  assert.equal(second.reused, true, 'the exact green check reads its receipt');
  assert.equal(checkouts, afterFirst, 'reuse avoids snapshot checks');
  rows = [{ item_id: 1, item_lane: 'core', item_title: 'different cut', item_status: 'verified', item_merged_commit: box.main }];
  const changed = await preflight(box.root, box.main, box.main, box.item, services);
  assert.notEqual(changed.reused, true, 'changed board authority cannot reuse the old receipt');
  assert.ok(checkouts > afterFirst);
});

test('shared cell inventory updates changed modules and reports structural fallback [C7,D3]', t => {
  const box = fixture(t);
  const main = git(box.root, 'rev-parse', 'HEAD').trim();
  const modes = [], key = { checkDigest: 'fixture-checker' };
  const first = inventoryCache(box.root, key, { importsIn, commonJsIn }, mode => modes.push(mode));
  const baseline = first.base(box.root, main);
  assert.equal(modes.at(-1), 'base-full');
  const second = inventoryCache(box.root, key, { importsIn, commonJsIn }, mode => modes.push(mode));
  const restored = second.base(box.root, main);
  assert.equal(modes.at(-1), 'base-cache');
  assert.deepEqual(restored.edges, baseline.edges);
  const changedPreload = inventoryCache(box.root, { ...key, config: { preloads: [{ token: 'fixture', digest: 'changed' }] } },
    { importsIn, commonJsIn }, mode => modes.push(mode));
  changedPreload.base(box.root, main);
  assert.equal(modes.at(-1), 'base-full', 'different preload bytes do not borrow a cached inventory');
  box.put('src/refused.js', 'export class Refused extends Error { value = 1; }\n');
  const updated = second.candidate(box.root, restored, ['src/refused.js']);
  assert.equal(modes.at(-1), 'candidate-incremental');
  const full = cellInventory(box.root, { importsIn, commonJsIn });
  assert.deepEqual(updated.files, full.files);
  assert.deepEqual(updated.edges, full.edges);
  assert.deepEqual(updated.unknown, full.unknown);
  box.put('src/extra.js', 'export const extra = true;\n');
  second.candidate(box.root, restored, ['src/extra.js']);
  assert.equal(modes.at(-1), 'candidate-full-fallback');
});

test('damaged inventory cache is discarded and rebuilt from the immutable snapshot [C7,D3]', t => {
  const box = fixture(t), main = git(box.root, 'rev-parse', 'HEAD').trim();
  const key = { checkDigest: 'damaged-inventory' }, parsers = { importsIn, commonJsIn }, modes = [];
  const first = inventoryCache(box.root, key, parsers, mode => modes.push(mode)).base(box.root, main);
  const directory = join(box.root, '.git', 'pullboard', 'cells-inventory');
  const file = join(directory, readdirSync(directory).find(name => name.endsWith('.json.gz')));
  writeFileSync(file, 'not a valid compressed inventory');
  const rebuilt = inventoryCache(box.root, key, parsers, mode => modes.push(mode)).base(box.root, main);
  assert.equal(modes.at(-1), 'base-full');
  assert.deepEqual(rebuilt.edges, first.edges);
  inventoryCache(box.root, key, parsers, mode => modes.push(mode)).base(box.root, main);
  assert.equal(modes.at(-1), 'base-cache', 'the rebuilt cache can be read');
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify({ version: 1, commit: main, payload: {} }))));
  inventoryCache(box.root, key, parsers, mode => modes.push(mode)).base(box.root, main);
  assert.equal(modes.at(-1), 'base-full', 'the old JSON format is not trusted as binary evidence');
});

test('one changed cell selects its importers without unrelated cells [C7,D3,CD64]', async t => {
  const box = plannedFixture(t);
  box.put('src/stats.js', "import { board } from './board.js';\nimport { readFileSync } from 'node:fs';\nexport const stats = () => [board, readFileSync, 1];\n");
  const result = await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item);
  assert.deepEqual(result.cells.sort(), ['app:cli', 'stats']);
});

test('changed immutable source cannot poison the shared cell inventory [C7,D3]', t => {
  const box = fixture(t), main = git(box.root, 'rev-parse', 'HEAD').trim();
  const key = { checkDigest: 'snapshot-custody' };
  const changing = { commonJsIn, importsIn(sources) {
    const result = importsIn(sources);
    box.put('src/refused.js', 'export const changed = true;\n');
    return result;
  } };
  const first = inventoryCache(box.root, key, changing);
  assert.throws(() => first.base(box.root, main), /immutable analysis snapshot changed/u);
  git(box.root, 'checkout', '--', 'src/refused.js');
  const modes = [];
  inventoryCache(box.root, key, { importsIn, commonJsIn }, mode => modes.push(mode)).base(box.root, main);
  assert.equal(modes.at(-1), 'base-full', 'the interrupted census did not publish cache evidence');
});

test('only direct importing cells join a touched cell, including another file in that cell [C7,D3,CD64]', () => {
  const cell = (name, paths) => ({ name, root: `packages/${name}`, frontDoor: `packages/${name}/index.js`, paths });
  const plan = { cells: [cell('a', [['src/a.js', 'packages/a/src/a.js'], ['src/a-other.js', 'packages/a/src/other.js']]),
    cell('b', [['src/b.js', 'packages/b/src/b.js']]), cell('c', [['src/c.js', 'packages/c/src/c.js']])] };
  const inventory = { edges: new Map([['src/b.js', [{ target: 'src/a-other.js' }]], ['src/c.js', [{ target: 'src/b.js' }]]]) };
  assert.deepEqual(touchedCells(['src/a.js'], plan, plan, [inventory]), ['a', 'b']);
  const forwarding = { ...inventory, files: new Map([['src/b.js', Buffer.from("export * from './a-other.js';\n")]]) };
  assert.deepEqual(touchedCells(['src/a.js'], plan, plan, [forwarding]), ['a', 'b', 'c'], 'effective importers through forwarding shims remain checked');
  const declared = { edges: new Map([['src/c.js', [{ target: 'src/b.js' }]]]),
    files: new Map([['src/a-other.js', Buffer.from('export const a = 1;')],
      ['src/b.js', Buffer.from('/** @pullboard-module-loads src/a-other.js */\nawait import(name);\n')]]),
    unknown: [{ file: 'src/b.js', specifier: '(computed)', reason: 'computed loader' }] };
  assert.deepEqual(touchedCells(['src/a.js'], plan, plan, [declared]), ['a', 'b', 'c'], 'declared computed forwarders use the same edges as cut checking');
  assert.deepEqual(touchedCells(['bin/cells-plan.json'], plan, plan, [inventory]), ['a', 'b', 'c'], 'shared authority invalidates every cell');
  const withStay = { ...plan, stays: [{ path: 'bin/shared.js' }] };
  assert.deepEqual(touchedCells(['bin/shared.js'], withStay, withStay, [inventory]), ['a', 'b', 'c'], 'unowned shared tool changes fail safely');
});

test('forwarding chains select every cell whose cut can change [C7,D3,CD64]', t => {
  const box = fixture(t);
  box.put('src/stats.js', "import './board.js'; export const stats = true;\n");
  box.put('src/board.js', "export * from './refused.js';\n");
  box.put('src/refused.js', 'export class Refused extends Error {}\n');
  const plan = computePlan(box.root);
  const oldInventory = cellInventory(box.root, { importsIn, commonJsIn });
  assert.deepEqual(checkCuts(box.root, plan, 'stats', { allLaterCells: true, inventory: oldInventory }), []);
  box.put('src/refused.js', "export * from './cli.js';\n");
  const newInventory = cellInventory(box.root, { importsIn, commonJsIn });
  assert.ok(touchedCells(['src/refused.js'], plan, plan, [oldInventory, newInventory]).includes('stats'));
  assert.ok(checkCuts(box.root, plan, 'stats', { allLaterCells: true, inventory: newInventory, acceptedInventory: oldInventory })
    .some(problem => problem.includes('stats still imports later app:cli')), 'the upstream cut really changes through the forwarding chain');
});

test('a one-cell submit on a many-cell board stays under a minute and still refuses a new cut [C7,D3,CD64]', async t => {
  const box = plannedFixture(t, ({ put }) => {
    const cells = { kernel: ['src/refused.js'], store: ['src/board.js'], items: ['src/claims.js'],
      stats: ['src/stats.js'], 'app:cli': ['src/cli.js'] };
    for (let index = 0; index < 96; index++) {
      const name = `extra${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`, file = `src/${name}.js`;
      cells[name] = [file];
      put(file, `export const ${name} = ${index};\n`);
    }
    put('bin/cells-plan/seed.json', JSON.stringify({ source: 'many-cell fixture', sha256: 'none', order: Object.keys(cells), cells, tests: {} }));
    put('bin/cells-plan/transition.json', JSON.stringify({ version: 1, deleteItem: 1770 }));
    moveFixtureKernel({ put }, 'export class Refused extends Error {}\n');
  });
  assert.ok(readPlan(box.root).cells.length >= 30, 'the real repository fixture has many planned cells');
  box.put('packages/kernel/src/core/refused.js', 'export class Refused extends Error {} // one-cell change\n');
  const candidate = commitCandidate(box);
  const compilerCalls = bindingCompilerCalls(t);
  const spawn = childProcess.spawn;
  let workers = 0;
  t.mock.method(childProcess, 'spawn', (...args) => {
    if (args[0] === process.execPath && args[1]?.some(value => String(value).endsWith('cell-parser-worker.js'))) workers++;
    return spawn(...args);
  });
  syncBuiltinESMExports();
  const started = performance.now();
  const result = await requireSubmitCells(box.root, box.main, candidate, box.item);
  const elapsed = performance.now() - started;
  t.diagnostic(`many-cell candidate stage: ${elapsed.toFixed(1)}ms`);
  assert.ok(elapsed < 60_000, `the complete cell stage took ${elapsed.toFixed(1)}ms; limit 60000ms`); // budget: ceiling from the #2313 bar (60 s for an ordinary change)
  assert.ok(compilerCalls() <= 4, 'compiler setup is bounded independently of the number of source files');
  assert.ok(workers <= 2, `the census uses at most two shared parser workers, got ${workers}`);
  assert.deepEqual(result.cells.sort(), ['kernel', 'store']);
  box.put('packages/kernel/src/core/refused.js', "import '../../../../src/stats-flow.js'; export class Refused extends Error {}\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /kernel --cuts: kernel still imports later stats/u,
    'the same many-cell board still refuses a new cut in a touched cell');
});

test('unchanged accepted cell cut evidence is reused across different candidate trees [C7,D3,CD64]', async t => {
  const box = plannedFixture(t), events = [];
  const services = { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache,
    readCutItems: (main, root) => acceptedCutItems(root, main), cacheEligible: () => true,
    onCellObservation: (mode, name) => events.push([mode, name]) };
  box.put('src/stats.js', "import { board } from './board.js';\nimport { readFileSync } from 'node:fs';\nexport const stats = () => [board, readFileSync, 1];\n");
  await preflight(box.root, box.main, commitCandidate(box), box.item, services);
  assert.ok(events.some(([mode, name]) => mode === 'base-checked' && name === 'stats'));
  events.length = 0;
  box.put('src/stats.js', "import { board } from './board.js';\nimport { readFileSync } from 'node:fs';\nexport const stats = () => [board, readFileSync, 2];\n");
  const second = await preflight(box.root, box.main, commitCandidate(box), box.item, services);
  assert.ok(events.some(([mode, name]) => mode === 'base-reused' && name === 'stats'), 'the actual accepted-base result survives a changed candidate tree');
  assert.deepEqual(second.problems, []);
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  await assert.rejects(preflight(box.root, box.main, commitCandidate(box), box.item, services), /kernel --cuts: kernel still imports later stats/u,
    'cached accepted evidence cannot hide a new candidate cut');
});

test('fixture binding compiler retries timeouts and names persistent timeouts [C7,D3]', t => {
  const original = childProcess.spawnSync;
  let calls = 0, always = false, firstTimeout;
  t.mock.method(childProcess, 'spawnSync', (...args) => {
    if (args[0] === process.execPath && args[1]?.includes('--experimental-vm-modules')) {
      calls++;
      if (always || calls === 1) {
        firstTimeout ??= args[2].timeout;
        return { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
      }
      if (calls === 2) assert.ok(args[2].timeout > firstTimeout);
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const source = "import { readFileSync } from 'node:fs'; const constructor = URL; readFileSync(new URL('../src/old.js', import.meta.url));";
  const options = { file: 'test/fixture.js', moves: [['src/old.js', 'packages/new.js']] };
  const retried = fixtureSourceEdits(source, options);
  assert.ok(calls >= 2, 'fixture analysis reached and retried its compiler');
  assert.deepEqual(retried.problems, [], 'fixture analysis passes after the retry');
  const modules = bindingModules();
  assert.ok(bindingReadsForModules(modules).get('binding-cache.js').get('join').reads.length > 0);
  always = true;
  assert.throws(() => bindingReadsForModules(modules), /compiler timeout after retry.*load .*cores/u);
  const fixture = fixtureSourceEdits(source, options);
  assert.match(fixture.problems.join(' '), /compiler timeout after retry.*load .*cores/u);
});

test('controller source steps cache only exact green source and base [C7,D3]', async t => {
  const { cachedSubmitSourceStep } = await import('../src/submit-controller-cache.js');
  const box = plannedFixture(t);
  const code = [fileURLToPath(new URL('../src/submit-controller-cache.js', import.meta.url))];
  const run = { kind: 'fixture-submit-step', base: box.main, source: box.main, code };
  let calls = 0;
  const first = await cachedSubmitSourceStep(box.root, run, () => { calls++; });
  assert.equal(first.reused, false);
  const second = await cachedSubmitSourceStep(box.root, run, () => { calls++; });
  assert.equal(second.reused, true, 'a completed identical source step avoids a second check');
  assert.equal(calls, 1);
  const originalOptions = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = '--require=/untrusted/preload.js';
    await cachedSubmitSourceStep(box.root, run, () => { calls++; });
  } finally { if (originalOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalOptions; }
  assert.equal(calls, 2, 'unknown preloads never reuse a receipt');
  await cachedSubmitSourceStep(box.root, { ...run, base: 'a'.repeat(40) }, () => { calls++; });
  assert.equal(calls, 3, 'a different accepted main cannot use the receipt');
  box.put('src/refused.js', 'export class Refused extends Error { changed = true; }\n');
  await cachedSubmitSourceStep(box.root, run, () => { calls++; });
  assert.equal(calls, 4, 'a dirty tree cannot use the receipt');
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'new source tree');
  const newer = git(box.root, 'rev-parse', 'HEAD').trim();
  await assert.rejects(cachedSubmitSourceStep(box.root, { ...run, source: newer }, () => { calls++; throw new Error('red'); }), /red/u);
  await cachedSubmitSourceStep(box.root, { ...run, source: newer }, () => { calls++; });
  assert.equal(calls, 6, 'a refused check is never recorded as green');
});
