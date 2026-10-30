import { acceptedCutItems } from './cells-plan-fixture.js';
import { withImportParseCache } from '../src/module-import-cache.js';
/** Submit checks use canonical immutable-source cell diagnostics [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
import { withMainCheckout } from '../src/main-red.js';
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
  const owned = new URL('../src/browser-slot-guard.js', import.meta.url).href;
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
  let cached;
  try { await requireSubmitCells(box.root, box.main, candidate, box.item); }
  catch (error) { cached = error; }
  assert.match(cached?.message ?? '', /kernel --cuts: kernel still imports later stats/u);
  const first = { ...observed }, before = process.env.NODE_OPTIONS;
  observed.imports = 0; observed.bindings = 0;
  try {
    process.env.NODE_OPTIONS = '--no-warnings';
    assert.equal(bindingCacheEligible(), false);
    let uncached;
    try { await requireSubmitCells(box.root, box.main, candidate, box.item); }
    catch (error) { uncached = error; }
    assert.equal(uncached?.message, cached.message, 'the exact full diagnostics do not change when canonical policy bypasses both caches');
    assert.ok(observed.imports > first.imports, 'actual submit entry bypasses import-parser reuse');
    assert.ok(observed.bindings > first.bindings, 'actual submit entry bypasses repeated binding-probe reuse');
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
