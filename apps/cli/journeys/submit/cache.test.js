/** A runner's cells stage reuses its nearest cached main inventory after main moves, across jobs and tool folders [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inventoryCache } from '../../../../packages/codemap/src/io/cells/scripts/cache.js';
import { inventoryCacheFile } from '../../../../packages/codemap/src/io/cells/scripts/cache.js';
import { cellInventory } from '../../../../packages/codemap/index.js';
import { createFixtureMemo } from '../../../../packages/codemap/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { commitOn } from '../../tests/fixtures/submit/cache.js';
import { freshJob } from '../../tests/fixtures/submit/cache.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';

/** Order unknown rows canonically; an incremental update appends where a census walks files in order. */
function canonical(inventory) {
  return { files: inventory.files, edges: inventory.edges, unknown: inventory.unknown.map(row => JSON.stringify(row)).sort() };
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
