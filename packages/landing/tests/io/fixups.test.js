/** @pullboard-test-input source-cell packages/landing */
/** Product landing carries the blitz-only fixups: listing rebind, renames, ceilings merge, static rows judged on main's baseline, row-aware blame [C7,#5560]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import { blameStaticRows } from '../../src/io/fixups.js';
import { judgeStaticAgainstBaseline } from '../../src/io/static.js';
import { landingRenames } from '../../src/io/fixups.js';
import { mergeCeilings } from '../../src/io/fixups.js';
import { rebindCellListing } from '../../src/io/fixups.js';
import { fixture } from '../fixtures/plan.js';
import { git } from '../fixtures/plan.js';

const LINTS = 'packages/codemap/data/baselines/lints';
const digest = text => createHash('sha256').update(text).digest('hex');

test('landing.fixups.n5560-clause-1-product-landing-rebinds: #5560 clause 1: product landing rebinds the cells listing to its shards, records renames and merges ceilings so the lower wins [C7]', t => {
  const { root, put } = fixture(t);
  // The listing: one metric over one shard whose allowances changed after the listing was written, and one cell file bound to it.
  put(`${LINTS}/shim-001.json`, JSON.stringify({ allowances: { 'a.js': 2, 'b.js': 3 } }));
  put(`${LINTS}/index.json`, JSON.stringify({ metrics: { shims: { count: 1, shards: [{ file: `${LINTS}/shim-001.json`, sha256: 'stale' }] } } }, null, 2) + '\n');
  put(`${LINTS}/cells/kernel.json`, JSON.stringify({ version: 1, cell: 'kernel', baseSha256: 'stale', metrics: { shims: { remove: ['z.js', 'y.js'] } }, sha256: 'stale' }));
  put('old/name.js', 'export const name = 1;\n// a line long enough to keep the rename similar\n// another line of the same file\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: base');
  const base = git(root, 'rev-parse', 'HEAD');
  mkdirSync(join(root, 'new'), { recursive: true });
  git(root, 'mv', 'old/name.js', 'new/name.js');
  git(root, 'commit', '-q', '-m', 'refactor: move');
  assert.deepEqual(landingRenames(root, base), [{ from: 'old/name.js', to: 'new/name.js' }]);
  assert.deepEqual(rebindCellListing(root).sort(), [`${LINTS}/cells/kernel.json`, `${LINTS}/index.json`]);
  const shard = readFileSync(join(root, `${LINTS}/shim-001.json`), 'utf8');
  const listing = JSON.parse(readFileSync(join(root, `${LINTS}/index.json`), 'utf8'));
  assert.equal(listing.metrics.shims.count, 5);
  assert.equal(listing.metrics.shims.shards[0].sha256, digest(shard));
  const cell = JSON.parse(readFileSync(join(root, `${LINTS}/cells/kernel.json`), 'utf8'));
  assert.equal(cell.baseSha256, digest(readFileSync(join(root, `${LINTS}/index.json`), 'utf8')));
  assert.deepEqual(cell.metrics.shims.remove, ['y.js', 'z.js']);
  assert.deepEqual(rebindCellListing(root), [], 'a second rebind changes nothing');
  // Ceilings: the lower number wins, a row one side deleted stays deleted, a row one side added is kept.
  const merged = mergeCeilings({ a: { x: 9, gone: 4 }, b: 5 }, { a: { x: 7, gone: 4 }, b: 5 }, { a: { x: 8 }, b: 3, c: 1 });
  assert.deepEqual(merged, { a: { x: 7 }, b: 3, c: 1 });
});

const RED = new Refused('GATE_RED', 'static checks are red; fix the named source before running proof:\nweb/old.txt:4: inherited row\nweb/new.txt:2: new collision');

test('landing.fixups.n5560-clause-2-product-landing-judges: #5560 clause 2: product landing judges static rows against the main baseline, so a row main prints never refuses and a new one does [C7]', () => {
  const baseline = 'web/old.txt:9: inherited row\n';
  const refusal = judgeStaticAgainstBaseline(RED, baseline, 'node checks.js');
  assert.ok(refusal instanceof Refused);
  assert.equal(refusal.code, 'LAND_STATIC_RED');
  assert.deepEqual(refusal.rows, [{ file: 'web/new.txt', line: 2, text: 'new collision' }]);
  assert.deepEqual(refusal.files, ['web/new.txt']);
  assert.doesNotMatch(refusal.message, /inherited row/u, 'the row moved from line 9 to 4 and is still main\'s');
  assert.equal(judgeStaticAgainstBaseline(RED, `${baseline}web/new.txt:7: new collision\n`), null, 'every red row is main\'s own');
  const other = new Refused('GATE_RED', 'tests are red');
  assert.equal(judgeStaticAgainstBaseline(other, baseline), other);
});

test('landing.fixups.n5560-clause-3-product-bisect-attributes: #5560 clause 3: product bisect attributes an added static row to the item that added it, not to every item that touched the file [C7]', t => {
  const { root, put } = fixture(t);
  put('web/shared.txt', 'one\ntwo\nthree\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: base');
  const base = git(root, 'rev-parse', 'HEAD');
  const branch = (name, text) => {
    git(root, 'checkout', '-q', '-b', name, base);
    writeFileSync(join(root, 'web/shared.txt'), text);
    git(root, 'commit', '-qam', `feat: ${name}`);
    return git(root, 'rev-parse', 'HEAD');
  };
  const first = branch('first', 'FIRST\ntwo\nthree\n');
  const second = branch('second', 'one\ntwo\nSECOND\n');
  git(root, 'checkout', '-q', '-b', 'merged', base);
  git(root, 'merge', '-q', '--no-edit', first, second);
  const entries = [{ id: 1, commit: first }, { id: 2, commit: second }];
  const charged = blameStaticRows(root, base, entries, [{ file: 'web/shared.txt', line: 3, text: 'bad word' }]);
  assert.deepEqual([...charged.keys()], [2], 'line 3 was written by the second item; the first only touched line 1');
  assert.deepEqual(blameStaticRows(root, base, entries, [{ file: 'web/shared.txt', line: 2, text: 'inherited' }]).size, 0, 'a line main held is nobody\'s');
});
