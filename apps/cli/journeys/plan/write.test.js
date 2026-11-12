/** @pullboard-test-input packages/codemap/data/plan/cells.json packages/codemap/data/plan/temporary-edges.json packages/codemap/src/io/cells/scripts/plan.js */
/** @pullboard-test-loads packages/codemap/src/io/cells/scripts/plan.js */
/** The plan writer keeps explicit migration contracts without retaining obsolete generated shards [C7,D3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { computePlan } from '../../../../packages/codemap/index.js';
import { placePath } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import { checkMoved } from '../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { stalePlanRows } from '../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { orphanCutEdges } from '../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { importCuts } from '../../../../packages/codemap/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';

const BIN = fileURLToPath(new URL('../../../../packages/codemap/src/io/cells/scripts/plan.js', import.meta.url));

test('plan --write preserves exact temporary edge contracts while removing stale plan shards [C7,D3,CD64]', t => {
  const { root, put } = fixture(t);
  const file = 'packages/codemap/data/plan/temporary-edges.json';
  const contracts = JSON.stringify({ version: 1, edges: [{ importer: 'src/board.js', target: 'src/claims.js', contractItem: 1624, expires: '2099-01-01' }] }, null, 2) + '\n';
  put(file, contracts);
  put('packages/codemap/data/plan/99-obsolete.json', '{}\n');
  const run = runFixtureChild(process.execPath, [BIN, '--write'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(join(root, file)), true, 'regeneration retains the live migration contract file');
  assert.equal(readFileSync(join(root, file), 'utf8'), contracts, 'regeneration neither drops nor rewrites contract bytes');
  assert.equal(existsSync(join(root, 'packages/codemap/data/plan/99-obsolete.json')), false, 'obsolete generated shards are still pruned');
  assert.deepEqual(readPlan(root), JSON.parse(JSON.stringify(computePlan(root))), 'the generated plan remains complete');
});

for (const mode of ['writePlan', '--place']) test(`${mode} keeps a two-space index placement diff to its row [C7,D3,CD60]`, t => {
  const { root, put } = fixture(t);
  writePlan(root, computePlan(root));
  const index = join(root, 'packages/codemap/data/plan/cells.json');
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
  assert.deepEqual(git(root, 'diff', '--name-only').trim().split('\n'), ['packages/codemap/data/plan/cells.json']);
  const expected = structuredClone(before);
  expected.stays.push({ path: added, reason: 'explicit bounded placement: stays in place during the move' });
  assert.equal(readPlan(root).totals.stays, before.stays.length + 1, 'the reader derives the new stay total');
  const after = readFileSync(index, 'utf8');
  assert.deepEqual(JSON.parse(after), expected, 'only the new stay changes on disk');
  assert.equal(after, JSON.stringify(expected, null, 2) + '\n', 'index bytes retain two-space indentation');
  const lines = git(root, 'diff', '--numstat', '--', 'packages/codemap/data/plan/cells.json').trim().split('\t');
  assert.deepEqual(lines, ['4', '0', 'packages/codemap/data/plan/cells.json'], 'one appended object, without a shared counter or formatting rewrite');
  for (const [file, bytes] of shards) assert.equal(readFileSync(join(root, file), 'utf8'), bytes, `${file} keeps its compact shard format`);
});

test('a deleted planned file is named stale by --check and --moved, and --retire moves its row to retired [C7,D3,CD64]', t => {
  const { root, put } = fixture(t);
  writePlan(root, computePlan(root));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture plan');
  const deleted = 'src/stats-flow.js';
  const owner = readPlan(root).cells.find(cell => cell.paths.some(([from]) => from === deleted));
  assert.ok(owner, 'the fixture plans the file before its deletion');
  rmSync(join(root, deleted));
  put('src/cli.js', "import { stats } from './stats.js';\nconsole.log(stats);\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'an item deletes a planned file');
  assert.deepEqual(stalePlanRows(root, readPlan(root)).map(entry => [entry.cell, entry.row[0]]), [[owner.name, deleted]]);
  const check = runFixtureChild(process.execPath, [BIN, '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 1, 'a stale row fails the plan check');
  assert.match(check.stderr, new RegExp(`stale plan row in \\S+: ${deleted} no longer exists; retire it: node packages/codemap/src/io/cells/scripts/plan.js --retire ${deleted}`, 'u'));
  assert.ok(checkMoved(root, readPlan(root), owner.name).includes(`${deleted} was deleted, so its plan row is stale; retire it: node packages/codemap/src/io/cells/scripts/plan.js --retire ${deleted}`),
    'the move check names the retire step rather than a missing target');
  const live = runFixtureChild(process.execPath, [BIN, '--retire', 'src/stats.js'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /CELLS_PLAN_RETIRE/u, 'a file that still exists never retires');
  const retire = runFixtureChild(process.execPath, [BIN, '--retire', deleted], { cwd: root, encoding: 'utf8' });
  assert.equal(retire.status, 0, retire.stderr);
  const plan = readPlan(root);
  assert.ok(!plan.cells.some(cell => cell.paths.some(([from]) => from === deleted) || cell.reexports.includes(deleted)
    || cell.cuts.some(link => link.edges.some(edge => edge.split('->').includes(deleted)))), 'no active row, shim or cut names the file');
  assert.deepEqual(plan.retired, [{ cell: owner.name, row: owner.paths.find(([from]) => from === deleted) }], 'its row keeps its provenance as retired');
  assert.equal(plan.totals.movedPaths, readPlan(root).cells.reduce((sum, cell) => sum + cell.paths.length, 0));
  assert.equal(runFixtureChild(process.execPath, [BIN, '--check'], { cwd: root, encoding: 'utf8' }).status, 0, 'the retired plan checks clean');
});

test('--retire refuses a deleted file that a live import still names [C7,D3,CD64]', t => {
  const { root } = fixture(t);
  writePlan(root, computePlan(root));
  rmSync(join(root, 'src/claims.js'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'delete a file its importer still names');
  const before = readFileSync(join(root, 'packages/codemap/data/plan/cells.json'), 'utf8');
  const retire = runFixtureChild(process.execPath, [BIN, '--retire', 'src/claims.js'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(retire.status, 0);
  assert.match(retire.stderr, /CELLS_PLAN_RETIRED[\s\S]*live import/u);
  assert.equal(readFileSync(join(root, 'packages/codemap/data/plan/cells.json'), 'utf8'), before, 'a refused retirement writes nothing');
});

test('--moved counts only unproven fixture reads the move made: exact main-base sites are notes, new or path-naming ones still refuse [C7,D3,CD64]', t => {
  const { root, put } = fixture(t);
  writePlan(root, computePlan(root));
  const reader = 'test/reader.test.js';
  const header = "import { readFileSync } from 'node:fs';\nconst moved = 'stats.js';\n";
  put(reader, header + "readFileSync(outputOf(box));\nreadFileSync(pick('stats.js'));\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'main with an unproven fixture read');
  git(root, 'checkout', '-q', '-b', 'move');
  put(reader, header + "\nreadFileSync(outputOf(box));\nreadFileSync(pick('stats.js'));\nreadFileSync(outputOf(box));\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'the move branch shifts a line and adds a second occurrence');
  const cell = readPlan(root).cells.find(entry => entry.paths.some(([from]) => from === 'src/stats.js'));
  const notes = [], problems = checkMoved(root, readPlan(root), cell.name, { notes }).filter(problem => problem.startsWith(reader));
  assert.deepEqual(notes.map(note => note.split(':')[1]), ['4'], 'the main-base site, found by its text even on a shifted line, is a note');
  assert.match(notes[0], /also at main [a-f0-9]{12}; not this move's obligation/u);
  assert.deepEqual(problems.map(problem => problem.split(':')[1]).sort(), ['5', '6'],
    'a read naming a moved basename and an extra occurrence of a known site both still count');
  /** Name the lines of every counted unproven read in the reader. */
  const counted = () => checkMoved(root, readPlan(root), cell.name).filter(problem => problem.startsWith(reader)).map(problem => problem.split(':')[1]).sort();
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--ff-only', 'move');
  assert.deepEqual(counted(), ['4', '5', '6'], 'on main itself there is no earlier base, so every unproven read counts');
  git(root, 'checkout', '-q', 'move');
  git(root, 'branch', '-q', '-D', 'main');
  assert.deepEqual(counted(), ['4', '5', '6'], 'without a main base every unproven read counts');
});

test('independent cell placements merge without a shared counter and read both new rows [C7,D3,CD60]', t => {
  const { root, put } = fixture(t);
  writePlan(root, computePlan(root));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'counter-free placement base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  const before = readPlan(root);
  const index = join(root, 'packages/codemap/data/plan/cells.json');
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
  const indexPath = join(root, 'packages/codemap/data/plan/cells.json');
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
  const index = JSON.parse(readFileSync(join(root, 'packages/codemap/data/plan/cells.json'), 'utf8'));
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
  const index = JSON.parse(readFileSync(join(root, 'packages/codemap/data/plan/cells.json'), 'utf8'));
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

for (const kind of ['dynamic', 'computed']) test(`--moved retains exact ${kind} refusal sites without excusing new or moved-source sites [C7,D3,CD64]`, t => {
  const { root, put } = fixture(t);
  writePlan(root, computePlan(root));
  put('src/opaque.js', 'export const value = {};\n');
  put('src/pure-port.js', 'export function make() { return {}; }\n');
  const reader = 'test/diagnostic-reader.test.js';
  const header = "const moved = 'stats.js';\n" + (kind === 'computed'
    ? "const { make } = await import('../src/pure-port.js');\nconst api = make();\n" : '');
  const known = kind === 'dynamic' ? "await import('../src/opaque.js');\n" : "api['run']();\n";
  const moved = kind === 'dynamic' ? "await import('../src/stats.js');\n" : "api['stats.js']();\n";
  put(reader, header + known + moved);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'main with exact unsupported diagnostic sites');
  git(root, 'checkout', '-q', '-b', 'move');
  put(reader, header + '\n' + known + moved + known);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'move shifts sites and adds another occurrence');
  const cell = readPlan(root).cells.find(entry => entry.paths.some(([from]) => from === 'src/stats.js'));
  const notes = [], problems = checkMoved(root, readPlan(root), cell.name, { notes }).filter(problem => problem.startsWith(reader));
  const originalLine = header.split('\n').length + 1;
  assert.equal(notes.length, 1, 'exact main custody permits only the single unchanged ordinary site');
  assert.ok(notes[0].startsWith(`${reader}:${originalLine}: unsupported fixture source:`));
  assert.match(notes[0], /also at main [a-f0-9]{12}/u);
  assert.deepEqual(problems.map(problem => Number(problem.split(':')[1])).sort((a, b) => a - b),
    [originalLine + 1, originalLine + 2], 'a basename-bearing site and an extra ordinary occurrence both still refuse');
});

test('a shim deleted by hand leaves no cut edge naming it: --check says so and --retire drops the edges [C7,D3,CD64]', t => {
  const { root } = fixture(t);
  const plan = computePlan(root);
  const link = plan.cells.flatMap(cell => cell.cuts.map(row => ({ cell, row }))).find(entry => entry.row.edges.length);
  assert.ok(link, 'the fixture plan records a cut');
  const shim = link.row.edges[0].split('->')[0];
  // What a shim-deletion item does: the file, its row and its re-export entry go; its cut edges used to stay.
  for (const cell of plan.cells) {
    cell.paths = cell.paths.filter(([from]) => from !== shim);
    cell.reexports = cell.reexports.filter(path => path !== shim);
  }
  writePlan(root, plan);
  rmSync(join(root, shim), { force: true });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'an item deletes a shim');
  assert.ok(orphanCutEdges(readPlan(root)).some(edge => edge.startsWith(`${shim}->`)), 'the edge naming the deleted shim is an orphan');
  assert.throws(() => importCuts(readPlan(root)), /outside its named cells/u, 'the cut reader refuses it, which is CELLS_SUBMIT at the gate');
  const check = runFixtureChild(process.execPath, [BIN, '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 1, 'the plan check fails');
  assert.match(check.stderr, new RegExp(`names ${shim}, which has no plan row; drop its cut edges: node packages/codemap/src/io/cells/scripts/plan.js --retire ${shim}`, 'u'));
  const retire = runFixtureChild(process.execPath, [BIN, '--retire', shim], { cwd: root, encoding: 'utf8' });
  assert.equal(retire.status, 0, retire.stderr);
  assert.deepEqual(orphanCutEdges(readPlan(root)), [], 'no cut edge names a file without a row');
  assert.doesNotThrow(() => importCuts(readPlan(root)), 'the cuts read again');
});
