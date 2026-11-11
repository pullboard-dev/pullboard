/** A runner's cells stage reuses its nearest cached main inventory after main moves, across jobs and tool folders [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { inventoryCache } from '../../../../packages/codemap/src/io/cells/scripts/cache.js';
import { inventoryCacheFile } from '../../../../packages/codemap/src/io/cells/scripts/cache.js';
import { cellInventory } from '../../../../packages/codemap/index.js';
import { createFixtureMemo } from '../../../../packages/codemap/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { submitCellsRemoteCommand } from '../../src/io/submit/remote.js';
import { produceAcceptedCells } from '../../../lib/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';

/** Order unknown rows canonically; an incremental update appends where a census walks files in order. */
function canonical(inventory) {
  return { files: inventory.files, edges: inventory.edges, unknown: inventory.unknown.map(row => JSON.stringify(row)).sort() };
}

/** Clone a repository into a fresh folder, the way each runner job starts from its own checkout. */
function freshJob(t, root) {
  const parent = mkdtempSync(join(tmpdir(), 'pullboard-cells-job-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const checkout = join(parent, 'job');
  git(parent, 'clone', '-q', '--shared', root, checkout);
  return checkout;
}

/** Commit one edit on top of a commit in a job checkout and leave it checked out; returns the new commit. */
function commitOn(job, base, file, text, message) {
  git(job, 'checkout', '-q', '--detach', base);
  mkdirSync(dirname(join(job, file)), { recursive: true });
  writeFileSync(join(job, file), text);
  git(job, 'add', '-A');
  git(job, 'commit', '-q', '-m', message);
  return git(job, 'rev-parse', 'HEAD').trim();
}

test('the inventory cache is found by every job, whatever folder its tools ran from [C7]', () => {
  // A runner runs main's tools from a fresh temporary folder, so the submit check's own key differs per job.
  const commit = 'a'.repeat(40);
  assert.equal(inventoryCacheFile({ checkDigest: `job-${randomUUID()}` }, commit), inventoryCacheFile({ checkDigest: `job-${randomUUID()}` }, commit));
});

test('main moved by one changed file: a fresh job updates the cached ancestor inventory to the same census [C7]', t => {
  const box = fixture(t), mainA = git(box.root, 'rev-parse', 'HEAD').trim(), modes = [];
  const parsers = { importsIn, commonJsIn };
  inventoryCache(box.root, { checkDigest: `first-${randomUUID()}` }, parsers, mode => modes.push(mode)).base(box.root, mainA);
  assert.equal(modes.at(-1), 'base-full');
  const job = freshJob(t, box.root);
  const mainB = commitOn(job, mainA, 'src/stats.js', `${readFileSync(join(job, 'src/stats.js'), 'utf8')}export const moved = true;\n`, 'main moves');
  const seen = [];
  const counting = { importsIn: sources => { seen.push(...sources); return importsIn(sources); }, commonJsIn };
  const base = inventoryCache(job, { checkDigest: `later-${randomUUID()}` }, counting, mode => modes.push(mode)).base(job, mainB);
  assert.equal(modes.at(-1), 'base-ancestor', 'the moved main starts from the cached ancestor');
  assert.deepEqual(seen, [readFileSync(join(job, 'src/stats.js'), 'utf8')], 'only the changed module is parsed');
  assert.deepEqual(canonical(base), canonical(cellInventory(job, parsers)), 'the updated inventory equals a full census of main B');
});

/**
 * Make a synthetic commit the job's main and run the real background producer for it, as main's audit does after a
 * landing; the cells stage reads only a completed accepted inventory and never builds one inline.
 */
async function producedMain(job, main) {
  git(job, 'branch', '-f', 'main', main);
  const produced = await produceAcceptedCells(job, randomUUID(), main);
  assert.ok(produced?.available === true || produced?.status === 0, `the accepted inventory producer completed for ${main}`);
}

/** Run the runner's actual remote cells command in a job checkout, timing its whole cells stage. */
function remoteCells(job, main, source) {
  const command = submitCellsRemoteCommand({ main, source, criterion: 'one cell file changes', title: 'probe', cutRows: [], node: process.execPath });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'NODE_OPTIONS' && key !== 'NODE_TEST_CONTEXT'));
  const started = performance.now();
  const run = runFixtureChild('/bin/sh', ['-c', command], { cwd: job, env, encoding: 'utf8' });
  const seconds = (performance.now() - started) / 1000;
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}`);
  assert.match(run.stdout, /PULLBOARD_CELLS_RESULT /u);
  return seconds;
}

test('clause 1: on this repository, a runner job whose main moved since the cached one runs the cells stage in under 30 s [C7]', { timeout: 590_000 }, async t => {
  const repository = fileURLToPath(new URL('../../../..', import.meta.url));
  const cellFile = 'packages/landing/src/io/step/failures.js';
  const first = freshJob(t, repository), mainA = git(first, 'rev-parse', 'HEAD').trim();
  const sourceA = commitOn(first, mainA, cellFile, `${readFileSync(join(first, cellFile), 'utf8')}// probe ${randomUUID()}\n`, 'a cell changes');
  await producedMain(first, mainA);
  const warmup = remoteCells(first, mainA, sourceA);
  t.diagnostic(`main A job: ${warmup.toFixed(1)} s`);

  // A later job: a new checkout, main's tools archived into a new temporary folder, and main one changed file ahead.
  const later = freshJob(t, repository);
  const mainB = commitOn(later, mainA, 'test/cells-probe-main.test.js', `export const moved = '${randomUUID()}';\n`, 'main moves by one file');
  const sourceB = commitOn(later, mainB, cellFile, `${readFileSync(join(later, cellFile), 'utf8')}// probe ${randomUUID()}\n`, 'a cell changes');
  await producedMain(later, mainB);
  const moved = remoteCells(later, mainB, sourceB);
  t.diagnostic(`main B job: ${moved.toFixed(1)} s`);
  assert.ok(moved < 30, `the cells stage took ${moved.toFixed(1)} s, over 30 s`); // budget: approved bar, cells stage under 30 s after main moves
});


test('one Git tree listing serves repeated unchanged fixture reads, and a changed commit gets its own blobs [C7]', t => {
  const box = fixture(t);
  const first = git(box.root, 'rev-parse', 'HEAD').trim();
  let reads = 0;
  const memo = createFixtureMemo({ onTreeRead: () => { reads += 1; } });
  const original = memo.treeBlobs(box.root, first);
  const originalObject = original.get('src/stats.js');
  assert.ok(originalObject, 'the committed regular file is inventoried');
  original.clear();
  assert.equal(memo.treeBlobs(box.root, first).get('src/stats.js'), originalObject, 'a caller cannot mutate cached tree identity');
  assert.equal(memo.treeBlobs(box.root, first).get('src/stats.js'), originalObject);
  assert.equal(reads, 1, 'unchanged fixture reads share one actual git ls-tree');
  writeFileSync(join(box.root, 'src/stats.js'), 'export const changed = true;\n');
  git(box.root, 'add', 'src/stats.js');
  git(box.root, 'commit', '-q', '-m', 'change one fixture input');
  const second = git(box.root, 'rev-parse', 'HEAD').trim();
  assert.notEqual(memo.treeBlobs(box.root, second).get('src/stats.js'), originalObject, 'a new commit never borrows the old blob');
  assert.equal(reads, 2, 'one additional Git listing accounts for the changed commit');
  assert.equal(memo.treeBlobs(box.root, first).get('src/stats.js'), originalObject);
  assert.equal(reads, 2, 'returning to the immutable base reuses its exact listing');
});
