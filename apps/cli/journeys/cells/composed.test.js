import { acceptedCutItems } from '../../../../packages/landing/tests/fixtures/plan.js';
/** Immutable submit census composes later accepted placement authority [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { computePlan } from '../../../../packages/codemap/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { shardFile } from '../../../../packages/codemap/index.js';
import { requireSubmitCells } from '../../index.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../packages/codemap/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { foreignNodeOptions } from '../../../../packages/gate/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { withFileLock } from '../../../../packages/outbox/index.js';

/** The submit services with the accepted inventory its background producer has already published for main. */
const servicesFor = acceptedArtifact => ({ withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache, acceptedArtifact,
  readCutItems: (main, root) => acceptedCutItems(root, main), cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });
const item = { item_frozen: JSON.stringify({ criterion: 'Preserve accepted placement authority and all cell boundaries.' }) };

/** Commit only actual fixture files through ordinary Git. */
function commit(box, message) {
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-qm', message);
  return git(box.root, 'rev-parse', 'HEAD').trim();
}

/** Main adds a real placed source after the candidate's base, in a different shard from deletion controls. */
async function diverged(t, change) {
  // The accepted inventory is produced off-path by a background producer (#3533), so this test publishes it in a private machine home.
  const previous = process.env.PULLBOARD_MACHINE_HOME, machine = privateFixtureFiles('cells-composed-machine-').root;
  process.env.PULLBOARD_MACHINE_HOME = machine;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(machine, { recursive: true, force: true });
  });
  const box = fixture(t);
  writePlan(box.root, computePlan(box.root));
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn })), { initialize: true });
  const base = commit(box, 'planned fixture with actual baseline');
  box.put('src/later.js', 'export const later = true;\n');
  const plan = readPlan(box.root), cell = plan.cells.find(row => row.name === 'stats');
  cell.paths.push(['src/later.js', `${cell.root}/src/core/later.js`, 'rule']);
  writePlan(box.root, plan);
  const main = commit(box, 'accepted main adds source and placement');
  const trunk = git(box.root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const artifact = await warmAcceptedCells(box.root, main, { withCheckout: withMainCheckout, withLock: withFileLock, trunk });
  assert.equal(artifact.available, true, 'the producer published the accepted inventory of main');
  git(box.root, 'checkout', '--detach', base);
  change(box);
  const candidate = commit(box, 'candidate based on earlier main');
  return { ...box, main, candidate, machine, services: servicesFor(artifact) };
}

/**
 * Read a composed commit the way the submit check wrote it: its objects live in the machine cache beside the repository's
 * own, never in the repository (#3533), so the reader names that directory as the object store and the repository as its alternate.
 */
function composed(box, ...args) {
  const alternate = realpathSync(git(box.root, 'rev-parse', '--path-format=absolute', '--git-path', 'objects').trim());
  const directory = join(box.machine, 'cells-cache', 'objects', createHash('sha256').update(alternate).digest('hex'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return runFixtureGit(args, { cwd: box.root, encoding: 'utf8', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_OBJECT_DIRECTORY: directory, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate } });
}

/** Record caller authority and mutable Git state before immutable inspection. */
function state(box) {
  return ['HEAD', 'index', 'refs'].map(name => name === 'HEAD' ? git(box.root, 'rev-parse', 'HEAD')
    : name === 'index' ? git(box.root, 'write-tree') : git(box.root, 'for-each-ref', '--format=%(refname) %(objectname)'));
}

test('clause 1: an older candidate preserves a later accepted source and row in its immutable census [C7,D3,CD64]', async t => {
  const box = await diverged(t, box => box.put('bin/tool.js', "import '../src/cli.js'; // independent candidate\n"));
  const before = state(box);
  const result = await requireSubmitCells(box.root, box.main, box.candidate, item, box.services);
  assert.deepEqual(result.problems, []);
  assert.equal(result.acceptedMain, box.main);
  assert.equal(result.source, box.candidate);
  assert.notEqual(result.commit, box.candidate, 'the older raw source is not mistaken for its composition');
  assert.equal(composed(box, 'rev-parse', `${result.commit}:src/later.js`),
    git(box.root, 'rev-parse', `${box.main}:src/later.js`), 'the exact accepted source blob survives composition');
  assert.equal(JSON.parse(composed(box, 'show', `${result.commit}:${shardFile(readPlan(box.root).cells.find(cell => cell.name === 'stats'))}`)).paths
    .filter(row => row[0] === 'src/later.js').length, 1);
  assert.deepEqual(state(box), before, 'the census never changes caller HEAD, index or refs');
});

test('clause 1: composing later main never forgives a candidate deletion of accepted ownership [C7,D3,CD64]', async t => {
  const box = await diverged(t, box => {
    const plan = readPlan(box.root), kernel = plan.cells.find(cell => cell.name === 'kernel');
    const row = kernel.paths.shift();
    plan.stays.push({ path: row[0], reason: 'candidate attempts to remove accepted authority' });
    writePlan(box.root, plan);
  });
  const before = state(box);
  await assert.rejects(requireSubmitCells(box.root, box.main, box.candidate, item, box.services),
    /accepted row src\/refused.js disappeared/u);
  assert.deepEqual(state(box), before);
});

test('clause 1: a conflicting candidate cannot substitute a guessed cells composition [C7,D3,CD64]', async t => {
  const box = await diverged(t, box => box.put('src/later.js', 'export const later = false;\n'));
  const before = state(box);
  await assert.rejects(requireSubmitCells(box.root, box.main, box.candidate, item, box.services),
    /cannot compose cleanly with pinned accepted main/u);
  assert.deepEqual(state(box), before);
});
