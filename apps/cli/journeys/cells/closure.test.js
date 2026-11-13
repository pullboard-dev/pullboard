/** @pullboard-test-input packages/codemap/data/plan/path-map/stats.json packages/codemap/data/plan/transition.json packages/stats/index.js packages/stats/src/logic/flow.js */
/** @pullboard-test-loads packages/runners/index.js packages/landing/index.js */
/** Landing aliases are removable only with equivalent imports and a bounded native move closure [C7,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { posix } from 'node:path';
import { test } from 'node:test';
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import { packageFiles } from '../../../../packages/runners/index.js';
import { runnerExecutionServices } from '../../../../packages/runners/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
import { foreignNodeOptions } from '../../../../packages/gate/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { moveDeclarationFiles } from '../../../../packages/codemap/index.js';
import { workingSourceInventory } from '../../../../packages/gate/src/io/scan.js';
import { sourceDirectories } from '../../../../packages/gate/tests/fixtures/functions.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { fixture as planFixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { acceptedCutItems } from '../../../../packages/landing/tests/fixtures/plan.js';
import { computePlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { requireSubmitCells } from '../../index.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../packages/codemap/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { landingExecutionServices } from '../../../../packages/landing/index.js';
import { landingBatches as pureLandingBatches } from '../../../../packages/git/browser.js';
import { landingBatches } from '../../../../packages/landing/index.js';

const parsers = { importsIn, commonJsIn };

test('landing history uses its existing pure port without growing any move closure [C7,H16]', t => {
  const root = join(import.meta.dirname, '..', '..', '..', '..');
  const fixture = mkdtempSync(join(tmpdir(), 'pullboard-landing-closure-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const old = 'src/landing-batch-history.js';
  const files = [...new Set([...packageFiles(root), old])];
  copyPackageFiles(root, fixture, { files: files.filter(file => file !== old) });
  mkdirSync(join(fixture, 'src'), { recursive: true });
  runFixtureGit(['init', '-q'], { cwd: fixture });
  runFixtureGit(['add', 'package.json', 'packages/codemap/data/plan/path-map'], { cwd: fixture });
  runFixtureGit(['-c', 'user.name=Closure fixture', '-c', 'user.email=closure@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Pin the copied source map'], { cwd: fixture });
  const callers = ['recordLandingBatch', 'finishLandingBatch'].map(name => `packages/moves/src/logic/moves/${name}.js`);
  /** Read the actual copied working bytes through the bounded source inventory. */
  const sources = () => new Map(workingSourceInventory(fixture, sourceDirectories(files)).map(({ file, body }) => [file, body]));
  const initial = sources();
  const current = new Map(callers.map(file => [file, initial.get(file).toString('utf8')]));
  /** Read the real complete finite registry graph, never an invented dependency count. */
  const closure = () => {
    const reached = moveDeclarationFiles(fixture, { files, ...parsers }), bodies = sources();
    return new Map([...reached].map(file => {
      assert.ok(bodies.has(file), `the actual working inventory contains ${file}`);
      return [file, bodies.get(file)];
    }));
  };
  /** Restore only the former forwarding layout around the same canonical provider. */
  const oldCallers = () => {
    for (const [file, source] of current) writeFileSync(join(fixture, file), source.replace('../../../../git/browser.js', posix.relative(posix.dirname(file), old)));
  };
  oldCallers();
  writeFileSync(join(fixture, old), "export { latestLandingBatch } from '../packages/git/browser.js';\n");
  const before = closure();
  for (const [file, source] of current) writeFileSync(join(fixture, file), source);
  rmSync(join(fixture, old));
  const after = closure();
  assert.equal(landingBatches, pureLandingBatches, 'the public Landing binding is the same pure Git projection');
  assert.ok(after.has('packages/git/browser.js'));
  assert.equal([...after.keys()].filter(file => file.startsWith('packages/landing/')).length, 0);
  assert.ok(after.size < before.size, 'removing forwards reduces the real registry module count');
  assert.ok([...after.values()].reduce((sum, bytes) => sum + bytes.length, 0)
    <= [...before.values()].reduce((sum, bytes) => sum + bytes.length, 0), 'actual source bytes do not grow');
  for (const [file, bytes] of after) {
    assert.ok(before.has(file), `${file} was already in the original closure`);
    if (!current.has(file)) assert.deepEqual(bytes, before.get(file), `${file} retains its exact body`);
  }
  oldCallers();
  writeFileSync(join(fixture, old), 'export * from "../packages/landing/index.js";\n');
  assert.throws(closure, /move closure exceeds source bounds/u, 'the full Landing door remains forbidden in Moves');
});

/** Commit an existing higher-cell dependency, choosing an actual barrel or a narrower provider. */
function forwardingFixture(t, fullBarrel, retain = false) {
  const box = planFixture(t);
  box.put('package.json', JSON.stringify({ type: 'module', bin: 'src/cli.js' }));
  box.put('src/refused.js', "import { flow } from './stats-flow.js'; export class Refused extends Error {}\n");
  box.put('packages/stats/index.js', "export { flow } from './src/logic/flow.js';\n");
  box.put('packages/stats/src/logic/flow.js', 'export const flow = 1;\n');
  box.put('src/stats-flow.js', fullBarrel ? "export * from '../packages/stats/index.js';\n"
    : "export { flow } from '../packages/stats/src/logic/flow.js';\n");
  box.put('packages/codemap/data/plan/path-map/stats.json', JSON.stringify({ 'src/stats-flow.js': fullBarrel ? 'packages/stats/index.js' : 'packages/stats/src/logic/flow.js' }));
  box.put('packages/codemap/data/plan/transition.json', JSON.stringify({ version: 1, deleteItem: 1770 }));
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'accepted exact forwarding fixture');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, parsers)), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'accepted forwarding baseline');
  const main = git(box.root, 'rev-parse', 'HEAD').trim();
  box.put('src/refused.js', "import { flow } from '../packages/stats/index.js'; export class Refused extends Error {}\n");
  if (!retain) box.put('src/cli.js', "import { stats } from './stats.js';\nimport { flow } from '../packages/stats/index.js';\nconsole.log(stats, flow);\n");
  if (!retain) rmSync(join(box.root, 'src/stats-flow.js'));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', 'replace the old alias with an explicit binding');
  const commit = git(box.root, 'rev-parse', 'HEAD').trim();
  return { ...box, main, commit };
}

/** Exercise the trusted immutable native submit guard with actual accepted source and its real import inventory. */
async function inspectForwarding(box) {
  // The accepted inventory is the background producer's completed census of main; the fixture warms it once, in a
  // disposable machine cache, as the producer would, because a submit check never builds it itself.
  const acceptedArtifact = await warmAcceptedCells(box.root, box.main, { withCheckout: withMainCheckout, withLock: withFileLock });
  return requireSubmitCells(box.root, box.main, box.commit, { item_frozen: JSON.stringify({ criterion: 'Remove the exact forwarding alias.' }) },
    { withMainCheckout, parsers, withImportParseCache, readCutItems: () => acceptedCutItems(box.root, box.main), acceptedArtifact,
      cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });
}

/** Keep machine-wide cache writes in a disposable directory and restore the invoking process's setting. */
function isolateMachine(t) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  const directory = privateFixtureFiles('closure-machine-').root;
  process.env.PULLBOARD_MACHINE_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}

test('an unchanged retained barrel also permits its core caller to use the exact door [C7,H16]', async t => {
  isolateMachine(t);
  const result = await inspectForwarding(forwardingFixture(t, true, true));
  assert.deepEqual(result.problems, []);
});

test('a narrow body cannot expand into a higher barrel through the alias cut [C7,H16]', async t => {
  isolateMachine(t);
  await assert.rejects(inspectForwarding(forwardingFixture(t, false)), error => error.code === 'CELLS_SUBMIT'
    && /kernel still imports later stats/u.test(error.message));
});


test('generated landing bindings keep the actual provider for legacy and canonical gate entries [C7,H16]', async () => {
  for (const entry of ['packages/gate/src/shell/test-run.js', 'packages/gate/index.js', 'packages/gate/src/shell/gate-slot.js']) {
    const source = executionServicesSource(new URL('../../../../' + entry, import.meta.url).href);
    const loaded = await import('data:text/javascript,' + encodeURIComponent(source + '\nexport { executionServices };'));
    assert.equal(loaded.executionServices.runners.runOnRunner, runnerExecutionServices().runOnRunner, entry);
    assert.equal(loaded.executionServices.landing.releaseExecutors, landingExecutionServices().releaseExecutors, entry);
  }
});
