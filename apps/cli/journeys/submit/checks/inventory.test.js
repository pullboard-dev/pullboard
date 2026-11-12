/** @pullboard-test-input apps/cli/src/io/cells-submit-checks.js packages/codemap/data/plan/cells.json packages/codemap/data/plan/path-map/kernel.json packages/codemap/data/plan/seed.json packages/codemap/data/plan/temporary-edges.json packages/codemap/data/plan/transition.json packages/gate/src/io/browser/guard.js */
import { inventoryCache } from '../../../../../packages/codemap/src/io/cells/scripts/cache.js';
import { inventoryCacheFile } from '../../../../../packages/codemap/src/io/cells/scripts/cache.js';
import { cellInventory } from '../../../../../packages/codemap/index.js';
import { acceptedCutItems } from '../../../../../packages/landing/tests/fixtures/plan.js';
import { cachedSubmitSourceStep } from '../../../src/io/submit/cache.js';
import { withImportParseCache } from '../../../../../packages/gate/index.js';
/** Submit checks use canonical immutable-source cell diagnostics [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import {
  rmSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
  after,
  test,
} from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCuts } from '../../../../../packages/codemap/src/io/cells/plan/cuts.js';
import { computePlan } from '../../../../../packages/codemap/index.js';
import { fixture } from '../../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../../packages/landing/tests/fixtures/plan.js';

import { requireSubmitCells as inspectSubmit } from '../../../index.js';
import { touchedCells } from '../../../index.js';
import { withMainCheckout } from '../../../../../packages/landing/index.js';
import { writePlan } from '../../../../../packages/codemap/index.js';
import { readPlan } from '../../../../../packages/codemap/index.js';
import { cellLintReport } from '../../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../../packages/codemap/index.js';
import { importsIn } from '../../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../../packages/gate/index.js';
import { warmAcceptedCells } from '../../../../../packages/gate/index.js';
import { withFileLock } from '../../../../../packages/outbox/index.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';

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

/** Move the real kernel body through its named front door and a committed per-cell path-map shard. */
function moveFixtureKernel(box, body) {
  box.put('packages/kernel/src/logic/refused.js', body);
  box.put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
  box.put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
  box.put('apps/cli/index.js', "import '../../src/cli.js';\n");
  box.put('packages/codemap/data/plan/path-map/kernel.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/logic/refused.js' }));
}

import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { lex } from '../../../../../packages/kernel/index.js';
import { bindingReadsForModules } from '../../../../../packages/codemap/index.js';
import { fixtureSourceEdits } from '../../../../../packages/codemap/index.js';
import { foreignNodeOptions } from '../../../../../packages/gate/index.js';

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


/** The refusal text a candidate draws, or an empty string when submit accepts it. */
async function refusal(promise) {
  try { await promise; return ''; } catch (error) { return error.message; }
}

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
  assert.equal(modes.at(-1), 'candidate-incremental', 'an added file is updated in place (#2531)');
  box.put('package.json', JSON.stringify({ type: 'module', imports: {} }));
  second.candidate(box.root, restored, ['package.json']);
  assert.equal(modes.at(-1), 'candidate-full-fallback');
});

test('damaged inventory cache is discarded and rebuilt from the immutable snapshot [C7,D3]', t => {
  const box = fixture(t), main = git(box.root, 'rev-parse', 'HEAD').trim();
  const key = { checkDigest: 'damaged-inventory' }, parsers = { importsIn, commonJsIn }, modes = [];
  const first = inventoryCache(box.root, key, parsers, mode => modes.push(mode)).base(box.root, main);
  const file = inventoryCacheFile(key, main);
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
  const box = await plannedFixture(t);
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
  assert.deepEqual(touchedCells(['packages/codemap/data/plan/cells.json'], plan, plan, [inventory]), ['a', 'b', 'c'], 'shared authority invalidates every cell');
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
  const box = await plannedFixture(t, ({ put }) => {
    const cells = { kernel: ['src/refused.js'], store: ['src/board.js'], items: ['src/claims.js'],
      stats: ['src/stats.js'], 'app:cli': ['src/cli.js'] };
    for (let index = 0; index < 96; index++) {
      const name = `extra${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`, file = `src/${name}.js`;
      cells[name] = [file];
      put(file, `export const ${name} = ${index};\n`);
    }
    put('packages/codemap/data/plan/seed.json', JSON.stringify({ source: 'many-cell fixture', sha256: 'none', order: Object.keys(cells), cells, tests: {} }));
    put('packages/codemap/data/plan/transition.json', JSON.stringify({ version: 1, deleteItem: 1770 }));
    moveFixtureKernel({ put }, 'export class Refused extends Error {}\n');
  });
  assert.ok(readPlan(box.root).cells.length >= 30, 'the real repository fixture has many planned cells');
  box.put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {} // one-cell change\n');
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
  box.put('packages/kernel/src/logic/refused.js', "import '../../../../src/stats-flow.js'; export class Refused extends Error {}\n");
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /kernel --cuts: kernel still imports later stats/u,
    'the same many-cell board still refuses a new cut in a touched cell');
});

test('unchanged accepted cell cut evidence is reused across different candidate trees [C7,D3,CD64]', async t => {
  const box = await plannedFixture(t), events = [];
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
  const box = await plannedFixture(t);
  const code = [fileURLToPath(new URL('../../../src/io/submit/cache.js', import.meta.url))];
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
