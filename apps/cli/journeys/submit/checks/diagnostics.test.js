/** @pullboard-test-input apps/cli/src/io/cells-submit-checks.js packages/codemap/data/plan/cells.json packages/codemap/data/plan/path-map/kernel.json packages/codemap/data/plan/seed.json packages/codemap/data/plan/temporary-edges.json packages/codemap/data/plan/transition.json packages/gate/src/io/browser/guard.js */
import { acceptedCutItems } from '../../../../../packages/landing/tests/fixtures/plan.js';
import { withImportParseCache } from '../../../../../packages/gate/index.js';
/** Submit checks use canonical immutable-source cell diagnostics [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  after,
  test,
} from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { computePlan } from '../../../../../packages/codemap/index.js';
import { fixture } from '../../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../../packages/landing/tests/fixtures/plan.js';

import { requireSubmitCells as inspectSubmit } from '../../../index.js';
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


import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
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


const bindingCacheEligible = () => !foreignNodeOptions(process.env.NODE_OPTIONS);

test('cached and canonically bypassed complete submit diagnostics agree with actual parser and binding work [C7,D3,CD64]', async t => {
  const box = await plannedFixture(t, box => {
    box.put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
    box.put('packages/kernel/index.js', "export { Refused } from './src/logic/refused.js';\n");
    box.put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
    box.put('path-map.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/logic/refused.js' }));
    box.put('test/reader.test.js', "import { readFileSync } from 'node:fs'; import { join } from 'node:path';\nexport function observe(root) { return readFileSync(join(root, 'src/refused.js'), 'utf8'); }\n");
    git(box.root, 'add', '-A'); git(box.root, 'commit', '-q', '-m', 'actual existing fixture reader obligation');
  });
  box.put('src/refused.js', "import './stats-flow.js'; export class Refused extends Error {}\n");
  const candidate = commitCandidate(box), observed = {};
  bindingCompilerCalls(t, observed);
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
    // A foreign preload may change what the parsers observe, so the accepted inventory cannot be reused under it and
    // submit refuses before any parser or binding work, rather than computing a different answer (#2711).
    await assert.rejects(run(box.item), /foreign Node preload prevents accepted cells inventory reuse/u,
      'canonical policy refuses a foreign preload instead of answering from a bypassed cache');
    assert.equal(observed.imports ?? 0, 0, 'the refusal does no import-parser work');
    assert.equal(observed.bindings ?? 0, 0, 'the refusal does no binding compiler work');
    assert.equal(requested, 0, 'the refusal requests no binding probe');
    // The accepted inventory serves the unchanged modules, so the refused candidate needs each binding once and none repeats;
    // the cross-run reuse is the computed === 0 check above, and census reuse has its own cases (#2711).
    assert.ok(first.computed > 0 && first.requested === first.computed, `the eligible actual submit probes each binding exactly once ${JSON.stringify(first)}`);
  } finally { if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before; }
});

/** Exercise the actual writer's 100-order filename, not an invented alternate reader spelling. */
test('submit reads canonical 100-order shards and refuses alternate shard identities [C7,D3]', async t => {
  const box = await plannedFixture(t), plan = readPlan(box.root);
  plan.cells.find(cell => cell.name === 'kernel').order = 100;
  writePlan(box.root, plan);
  const commit = commitCandidate(box);
  const index = JSON.parse(git(box.root, 'show', `${commit}:packages/codemap/data/plan/cells.json`));
  const row = index.cells.find(cell => cell.name === 'kernel');
  assert.equal(row.file, 'packages/codemap/data/plan/100-kernel.json');
  await assert.rejects(requireSubmitCells(box.root, box.main, commit, box.item), /accepted cell kernel identity\/order\/front door changed/u,
    'the canonical writer filename reaches the original ownership/order guard');
  const original = git(box.root, 'show', `${commit}:${row.file}`);
  for (const alias of ['packages/codemap/data/plan/0100-kernel.json', 'packages/codemap/data/plan/100-git.json']) {
    row.file = alias;
    box.put(alias, original);
    box.put('packages/codemap/data/plan/cells.json', JSON.stringify(index));
    const forged = commitCandidate(box);
    assert.equal(git(box.root, 'show', `${forged}:${alias}`), original, 'the alternate really exists with the same committed body');
    await assert.rejects(requireSubmitCells(box.root, box.main, forged, box.item), /CELLS_PLAN_SHARD/u,
      'an extra zero or mismatched name cannot change canonical shard identity');
  }
});

test('scheduled rows stay unmoved while mapped cells retain real missing-body checks [C7,D3,CD64]', async t => {
  const box = await plannedFixture(t);
  const plan = readPlan(box.root), kernel = plan.cells.find(cell => cell.name === 'kernel');
  box.put('src/new.css', 'body { color: red; }\n');
  kernel.paths.push(['src/new.css', 'packages/kernel/src/shell/new.css', 'rule']);
  writePlan(box.root, plan);
  assert.deepEqual((await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item)).problems, [],
    'a scheduled asset in an unmoved cell does not require its future body');
  box.put('path-map.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/logic/refused.js' }));
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /kernel --moved: missing/u,
    'an actual mapped move still refuses missing implementation bytes');
});

test('outside-cell changes do not widen touched cells but still refuse unplaced source [C7,D3,CD64]', async t => {
  const box = await plannedFixture(t);
  box.put('test/ordinary.test.js', '// real outside-cell test change\n');
  const result = await requireSubmitCells(box.root, box.main, commitCandidate(box), box.item);
  assert.deepEqual(result.cells, []);
  assert.deepEqual(result.problems, []);
  box.put('src/unplanned.js', 'export const value = 1;\n');
  await assert.rejects(requireSubmitCells(box.root, box.main, commitCandidate(box), box.item), /no cells-plan entry: src\/unplanned.js/u);
});

/** The refusal text a candidate draws, or an empty string when submit accepts it. */
async function refusal(promise) {
  try { await promise; return ''; } catch (error) { return error.message; }
}

test('submit refuses deleting a module a test names inside a generated script, never for a comment or prose mention [C7,D3]', async t => {
  for (const form of [() => './src/doomed.js', () => '${ROOT}/src/doomed.js', root => join(root, 'src/doomed.js'), root => pathToFileURL(join(root, 'src/doomed.js')).href]) {
    const box = await plannedFixture(t, fixture => {
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
  const box = await plannedFixture(t);
  let reads = 0, rows = [];
  const services = { parsers: { importsIn, commonJsIn }, withImportParseCache,
    cacheEligible: () => true, readCutItems: () => rows, withMainCheckout, onSnapshotRead: () => { reads++; } };
  box.put('src/stats.js', "import { board } from './board.js';\nimport { readFileSync } from 'node:fs';\nexport const stats = () => [board, readFileSync, 1];\n");
  const candidate = commitCandidate(box);
  const first = await preflight(box.root, box.main, candidate, box.item, services);
  assert.deepEqual(first.problems, []);
  const afterFirst = reads;
  assert.ok(afterFirst > 0, 'the first check reads the changed file from the immutable snapshot');
  const second = await preflight(box.root, box.main, candidate, box.item, services);
  assert.equal(second.reused, true, 'the exact green check reads its receipt');
  assert.equal(reads, afterFirst, 'reuse avoids snapshot reads');
  rows = [{ item_id: 1, item_lane: 'core', item_title: 'different cut', item_status: 'verified', item_merged_commit: box.main }];
  const changed = await preflight(box.root, box.main, candidate, box.item, services);
  assert.notEqual(changed.reused, true, 'changed board authority cannot reuse the old receipt');
  assert.ok(reads > afterFirst, 'the changed authority inspects the snapshot again');
});

