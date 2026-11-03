/** The cells check costs in proportion to the diff: a machine-level base cache and incremental candidate updates [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inventoryCache } from '../bin/cells-inventory-cache.js';
import { inventoryCacheFile } from '../bin/cells-inventory-cache.js';
import { cellInventory } from '../packages/codemap/index.js';
import { updateCellInventory } from '../packages/codemap/index.js';
import { importsIn } from '../packages/gate/index.js';
import { commonJsIn } from '../packages/gate/index.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';

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
  git(parent, 'clone', '-q', root, checkout);
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
  for (const file of ['package.json', 'packages/kernel/index.js', 'packages/kernel/src/core/discovery.js']) {
    cache.candidate(box.root, base, [file]);
    assert.equal(modes.at(-1), 'candidate-full-fallback', file);
  }
});
