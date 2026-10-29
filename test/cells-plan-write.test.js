/** @pullboard-test-input source-tree */
/** @pullboard-test-loads bin/cells-plan.js */
/** The plan writer keeps explicit migration contracts without retaining obsolete generated shards [C7,D3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { computePlan } from '../bin/cells-plan.js';
import { placePath } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { runFixtureChild } from './fixture-child.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';

const BIN = fileURLToPath(new URL('../bin/cells-plan.js', import.meta.url));

test('plan --write preserves exact temporary edge contracts while removing stale plan shards [C7,D3,CD64]', t => {
  const { root, put } = fixture(t);
  const file = 'bin/cells-plan/temporary-edges.json';
  const contracts = JSON.stringify({ version: 1, edges: [{ importer: 'src/board.js', target: 'src/claims.js', contractItem: 1624, expires: '2099-01-01' }] }, null, 2) + '\n';
  put(file, contracts);
  put('bin/cells-plan/99-obsolete.json', '{}\n');
  const run = runFixtureChild(process.execPath, [BIN, '--write'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(join(root, file)), true, 'regeneration retains the live migration contract file');
  assert.equal(readFileSync(join(root, file), 'utf8'), contracts, 'regeneration neither drops nor rewrites contract bytes');
  assert.equal(existsSync(join(root, 'bin/cells-plan/99-obsolete.json')), false, 'obsolete generated shards are still pruned');
  assert.deepEqual(readPlan(root), JSON.parse(JSON.stringify(computePlan(root))), 'the generated plan remains complete');
});

for (const mode of ['writePlan', '--place']) test(`${mode} keeps a two-space index placement diff to its row [C7,D3,CD60]`, t => {
  const { root, put } = fixture(t);
  writePlan(root, computePlan(root));
  const index = join(root, 'bin/cells-plan.json');
  const before = JSON.parse(readFileSync(index, 'utf8'));
  // Establish the existing repository convention independently of the writer under test.
  writeFileSync(index, JSON.stringify(before, null, 2) + '\n');
  const added = 'bin/added-tool.js';
  put(added, 'export const tool = true;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'two-space fixture plan');
  const shards = before.cells.map(cell => [cell.file, readFileSync(join(root, cell.file), 'utf8')]);
  if (mode === 'writePlan') placePath(root, added, { stay: true });
  else {
    const result = runFixtureChild(process.execPath, [BIN, '--place', added, '--stay'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  assert.deepEqual(git(root, 'diff', '--name-only').trim().split('\n'), ['bin/cells-plan.json']);
  const expected = structuredClone(before);
  expected.stays.push({ path: added, reason: 'explicit bounded placement: stays in place during the move' });
  assert.equal(readPlan(root).totals.stays, before.stays.length + 1, 'the reader derives the new stay total');
  const after = readFileSync(index, 'utf8');
  assert.deepEqual(JSON.parse(after), expected, 'only the new stay changes on disk');
  assert.equal(after, JSON.stringify(expected, null, 2) + '\n', 'index bytes retain two-space indentation');
  const lines = git(root, 'diff', '--numstat', '--', 'bin/cells-plan.json').trim().split('\t');
  assert.deepEqual(lines, ['4', '0', 'bin/cells-plan.json'], 'one appended object, without a shared counter or formatting rewrite');
  for (const [file, bytes] of shards) assert.equal(readFileSync(join(root, file), 'utf8'), bytes, `${file} keeps its compact shard format`);
});

test('independent cell placements merge without a shared counter and read both new rows [C7,D3,CD60]', t => {
  const { root, put } = fixture(t);
  writePlan(root, computePlan(root));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'counter-free placement base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  const before = readPlan(root);
  const index = join(root, 'bin/cells-plan.json');
  const indexBytes = readFileSync(index, 'utf8');
  assert.equal(Object.hasOwn(JSON.parse(indexBytes), 'totals'), false, 'the committed index contains no derived counter block');
  /** Commit one actual new source placement without changing the shared index. */
  function place(file, cell) {
    put(file, 'export const placed = true;\n');
    git(root, 'add', '--', file);
    placePath(root, file, { cell });
    assert.equal(readFileSync(index, 'utf8'), indexBytes, 'a placement changes its own shard, not the shared index');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `place ${file}`);
    return git(root, 'rev-parse', 'HEAD').trim();
  }
  const left = place('src/left-counter-fixture.js', 'kernel');
  git(root, 'switch', '--detach', base);
  const right = place('src/right-counter-fixture.js', 'stats');
  const tree = git(root, 'merge-tree', '--write-tree', left, right).trim();
  assert.match(tree, /^[0-9a-f]{40,64}$/u, 'Git merges the two independent placements without a conflict');
  const merged = git(root, 'commit-tree', tree, '-p', left, '-p', right, '-m', 'merge independent placements').trim();
  git(root, 'switch', '--detach', merged);
  const after = readPlan(root);
  assert.equal(after.totals.movedPaths, before.totals.movedPaths + 2, 'both additions contribute; a max of cached totals would lose one');
  for (const [file, cell] of [['src/left-counter-fixture.js', 'kernel'], ['src/right-counter-fixture.js', 'stats']]) {
    assert.equal(after.cells.find(row => row.name === cell).paths.filter(row => row[0] === file).length, 1, 'each exact source row survives once in its own cell');
  }
  const check = runFixtureChild(process.execPath, [BIN, '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});


test('the reader ignores stale legacy summaries and the writer persists only authoritative rows [C7,D3,CD60]', t => {
  const { root } = fixture(t);
  const expected = JSON.parse(JSON.stringify(computePlan(root)));
  const stale = structuredClone(expected);
  stale.totals.movedPaths = -99;
  stale.cells[0].placedBy = { seed: -99, rule: -99, imports: -99 };
  writePlan(root, stale);
  const indexPath = join(root, 'bin/cells-plan.json');
  const indexBytes = readFileSync(indexPath, 'utf8');
  const index = JSON.parse(indexBytes);
  assert.equal(Object.hasOwn(index, 'totals'), false);
  const shards = index.cells.map(row => [row.file, readFileSync(join(root, row.file), 'utf8')]);
  for (const [, bytes] of shards) assert.equal(Object.hasOwn(JSON.parse(bytes), 'placedBy'), false);
  assert.deepEqual(readPlan(root), expected, 'stale caller summaries do not affect the rows or returned plan');
  index.totals = { movedPaths: -99 };
  writeFileSync(indexPath, JSON.stringify(index));
  for (const [file, bytes] of shards) {
    const shard = JSON.parse(bytes);
    shard.placedBy = { seed: -99, rule: -99, imports: -99 };
    writeFileSync(join(root, file), JSON.stringify(shard));
  }
  assert.deepEqual(readPlan(root), expected, 'legacy cached summaries are recomputed from the unchanged rows');
  writePlan(root, readPlan(root));
  assert.equal(readFileSync(indexPath, 'utf8'), indexBytes, 'normalizing legacy summaries restores identical index bytes');
  for (const [file, bytes] of shards) assert.equal(readFileSync(join(root, file), 'utf8'), bytes, `${file} normalizes to identical row bytes`);
});


test('--check refuses an on-disk path that cannot contribute to exactly one placement bucket [C7,D3,CD60]', t => {
  const { root } = fixture(t);
  const plan = computePlan(root);
  plan.cells[0].paths[0][2] = 'unknown';
  assert.throws(() => writePlan(root, plan), { code: 'CELLS_UNPLACED' }, 'the existing writer guard stays enforced');
  plan.cells[0].paths[0][2] = 'seed';
  writePlan(root, plan);
  const index = JSON.parse(readFileSync(join(root, 'bin/cells-plan.json'), 'utf8'));
  const file = join(root, index.cells[0].file);
  const shard = JSON.parse(readFileSync(file, 'utf8'));
  shard.paths[0][2] = 'unknown';
  writeFileSync(file, JSON.stringify(shard));
  const run = runFixtureChild(process.execPath, [BIN, '--check'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /CELLS_UNPLACED/u);
});

test('--check refuses cut rows that cannot produce valid integer import counts [C7,D3,CD64]', t => {
  const { root } = fixture(t);
  writePlan(root, computePlan(root));
  const index = JSON.parse(readFileSync(join(root, 'bin/cells-plan.json'), 'utf8'));
  const file = index.cells.map(row => join(root, row.file)).find(path => JSON.parse(readFileSync(path, 'utf8')).cuts.length);
  assert.ok(file, 'the real fixture contains a declared cut');
  const shard = JSON.parse(readFileSync(file, 'utf8'));
  for (const invalid of [-1, 1.5, '1']) {
    shard.cuts[0].imports = invalid;
    writeFileSync(file, JSON.stringify(shard));
    const run = runFixtureChild(process.execPath, [BIN, '--check'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(run.status, 0, `invalid count ${JSON.stringify(invalid)} is refused`);
    assert.match(run.stderr, /CELLS_PLAN_COUNTS/u);
  }
});
