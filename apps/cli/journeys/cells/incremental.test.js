/** The cells check costs in proportion to the diff: a machine-level base cache and incremental candidate updates [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inventoryCache } from '../../../../packages/codemap/src/io/cells/scripts/cache.js';
import { inventoryCacheFile } from '../../../../packages/codemap/src/io/cells/scripts/cache.js';
import { cellInventory } from '../../../../packages/codemap/index.js';
import { updateCellInventory } from '../../../../packages/codemap/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
import { foreignNodeOptions } from '../../../../packages/gate/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { requireSubmitCells } from '../../index.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';

/** Order unknown rows canonically; an incremental update appends where a census walks files in order. */
function canonical(inventory) {
  return { files: inventory.files, edges: inventory.edges, unknown: inventory.unknown.map(row => JSON.stringify(row)).sort() };
}

/** Parsers that count how many module sources each update reads, so a test can prove the cost follows the diff. */
function countingParsers() {
  const seen = [];
  return { seen, parsers: { importsIn: sources => { seen.push(...sources); return importsIn(sources); }, commonJsIn } };
}

/** Clone the fixture into a fresh folder, the way each runner job starts from its own checkout. */
function freshJob(t, root) {
  const parent = mkdtempSync(join(tmpdir(), 'pullboard-cells-job-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const checkout = join(parent, 'job');
  git(parent, 'clone', '-q', '--shared', root, checkout);
  return checkout;
}

test('a fresh runner job reads main\'s inventory from the machine cache, and an added file updates incrementally [C7]', t => {
  const box = fixture(t), main = git(box.root, 'rev-parse', 'HEAD').trim();
  const key = { checkDigest: `incremental-${randomUUID()}` }, modes = [];
  const first = inventoryCache(box.root, key, { importsIn, commonJsIn }, mode => modes.push(mode));
  first.base(box.root, main);
  assert.equal(modes.at(-1), 'base-full');
  const file = inventoryCacheFile(key, main);
  assert.ok(existsSync(file), 'the base inventory is published to the machine cache');
  assert.ok(!file.startsWith(box.root), 'the cache lives outside the job checkout and its Git directory');

  const job = freshJob(t, box.root);
  const { seen, parsers } = countingParsers();
  const cache = inventoryCache(job, key, parsers, mode => modes.push(mode));
  const base = cache.base(job, main);
  assert.equal(modes.at(-1), 'base-cache', 'a later job with a new checkout reuses the warm base');
  assert.equal(seen.length, 0, 'a warm base parses no module');

  box.put('src/extra.js', "import { stats } from './stats.js';\nexport const extra = () => stats;\n");
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'add a file');
  git(job, 'pull', '-q', '--ff-only');
  const updated = cache.candidate(job, base, ['src/extra.js']);
  assert.equal(modes.at(-1), 'candidate-incremental', 'an item that adds a file never falls back to a full census');
  assert.deepEqual(seen, [readFileSync(join(job, 'src/extra.js'), 'utf8')], 'only the added module is parsed');
  assert.deepEqual(canonical(updated), canonical(cellInventory(job, { importsIn, commonJsIn })));
});

test('incremental update matches a full census for deleted files, waiting importers and non-regular entries [C7]', t => {
  const box = fixture(t);
  box.put('src/late.js', "import { soon } from './soon.js';\nexport const late = soon;\n");
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'importer waits on a missing file');
  const parsers = { importsIn, commonJsIn };
  const prior = cellInventory(box.root, parsers);
  assert.ok(prior.unknown.some(row => row.file === 'src/late.js' && /missing import target src\/soon\.js/u.test(row.reason)));

  rmSync(join(box.root, 'src/stats-flow.js'));
  box.put('src/soon.js', 'export const soon = 1;\n');
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'delete one, add the awaited one');
  const changed = ['src/stats-flow.js', 'src/soon.js'];
  const updated = updateCellInventory(box.root, parsers, prior, changed);
  const full = cellInventory(box.root, parsers);
  assert.deepEqual(canonical(updated), canonical(full));
  assert.ok(!updated.files.has('src/stats-flow.js') && !updated.edges.has('src/stats-flow.js'));
  assert.ok(updated.unknown.some(row => row.file === 'src/cli.js' && /missing import target src\/stats-flow\.js/u.test(row.reason)),
    'an importer of a deleted file now names it missing');
  assert.ok(updated.edges.get('src/late.js').some(row => row.target === 'src/soon.js'), 'the awaited file resolves its importer');

  const before = cellInventory(box.root, parsers);
  rmSync(join(box.root, 'src/soon.js'));
  symlinkSync('refused.js', join(box.root, 'src/soon.js'));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'replace with a symlink');
  assert.deepEqual(canonical(updateCellInventory(box.root, parsers, before, ['src/soon.js'])), canonical(cellInventory(box.root, parsers)));
});

test('package.json, the kernel front door and discovery.js keep the full census [C7]', t => {
  const box = fixture(t), main = git(box.root, 'rev-parse', 'HEAD').trim(), modes = [];
  const cache = inventoryCache(box.root, { checkDigest: `fallback-${randomUUID()}` }, { importsIn, commonJsIn }, mode => modes.push(mode));
  const base = cache.base(box.root, main);
  for (const file of ['package.json', 'packages/kernel/index.js', 'packages/kernel/src/logic/discovery.js']) {
    cache.candidate(box.root, base, [file]);
    assert.equal(modes.at(-1), 'candidate-full-fallback', file);
  }
});

/** Commit one added test file on top of main in the job checkout and leave it checked out. */
function addFileCandidate(job, main, name) {
  git(job, 'checkout', '-q', '--detach', main);
  // A diff confined to root test/ and docs/ skips the cells step (bin/cells-submit-checks.js), so the probe lands in a cell's tests folder.
  writeFileSync(join(job, 'packages', 'items', 'tests', name), 'export const probe = true;\n');
  git(job, 'add', '-A');
  git(job, 'commit', '-q', '-m', `add ${name}`);
  return git(job, 'rev-parse', 'HEAD').trim();
}

/** Run the submit cells check exactly as the remote analysis entry does, returning its inventory modes and seconds. */
async function cellsStep(job, main, source) {
  // The accepted-main inventory is produced by a background job on a runner; the test produces its own and never waits on one.
  await warmAcceptedCells(job, main, { withCheckout: withMainCheckout, withLock: withFileLock, trunk: main });
  const modes = [], started = performance.now();
  let result;
  try {
    result = await requireSubmitCells(job, main, source, { item_frozen: JSON.stringify({ criterion: 'add one test file' }), item_title: 'add one test file' }, {
      withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache,
      cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS), readCutItems: () => [],
      onInventory: mode => modes.push(mode) });
  } catch (error) {
    // A finding on main is a verdict, not a cost: the step still ran its inventories and the timing stands.
    if (error?.code !== 'CELLS_SUBMIT') throw error;
    result = { refused: error.message };
  }
  return { modes, seconds: (performance.now() - started) / 1000, result };
}

test('on this repository, a later item that adds a file runs the cells step in under 60 s from a warm base [C7]', { timeout: 590_000 }, async t => {
  const repository = fileURLToPath(new URL('../../../..', import.meta.url));
  const job = freshJob(t, repository), main = git(job, 'rev-parse', 'HEAD').trim();
  const first = await cellsStep(job, main, addFileCandidate(job, main, `cells-probe-${randomUUID()}.test.js`));
  t.diagnostic(`first job: ${first.seconds.toFixed(1)} s, inventory ${first.modes.join(', ')}`);
  assert.ok(!first.modes.includes('candidate-full-fallback'), 'an added file never forces a full census');

  const later = freshJob(t, repository);
  const warm = await cellsStep(later, main, addFileCandidate(later, main, `cells-probe-${randomUUID()}.test.js`));
  t.diagnostic(`later job: ${warm.seconds.toFixed(1)} s, inventory ${warm.modes.join(', ')}`);
  assert.ok(warm.modes.length > 0 && warm.modes.every(mode => mode === 'base-cache' || mode === 'candidate-incremental'),
    `a later job reads main from the machine cache and updates the candidate in place: ${warm.modes.join(', ')}`);
  assert.ok(warm.modes.includes('base-cache') && warm.modes.includes('candidate-incremental'));
  assert.ok(warm.seconds < 60, `the cells step took ${warm.seconds.toFixed(1)} s, over 60 s`);
});
