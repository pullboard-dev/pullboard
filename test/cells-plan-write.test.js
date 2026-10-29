/** @pullboard-test-input source-tree */
/** @pullboard-test-loads bin/cells-plan.js */
/** The plan writer keeps explicit migration contracts without retaining obsolete generated shards [C7,D3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { computePlan } from '../bin/cells-plan.js';
import { placePath } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { checkMoved } from '../bin/cells-plan.js';
import { stalePlanRows } from '../bin/cells-plan.js';
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

for (const mode of ['writePlan', '--place']) test(`${mode} keeps a two-space index placement diff to its row and totals [C7,D3,CD60]`, t => {
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
  expected.totals.stays += 1;
  expected.stays.push({ path: added, reason: 'explicit bounded placement: stays in place during the move' });
  const after = readFileSync(index, 'utf8');
  assert.deepEqual(JSON.parse(after), expected, 'only the new stay and its total change');
  assert.equal(after, JSON.stringify(expected, null, 2) + '\n', 'index bytes retain two-space indentation');
  const lines = git(root, 'diff', '--numstat', '--', 'bin/cells-plan.json').trim().split('\t');
  assert.deepEqual(lines, ['5', '1', 'bin/cells-plan.json'], 'one counter and one appended object, without a formatting rewrite');
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
  assert.match(check.stderr, new RegExp(`stale plan row in \\S+: ${deleted} no longer exists; retire it: node bin/cells-plan.js --retire ${deleted}`, 'u'));
  assert.ok(checkMoved(root, readPlan(root), owner.name).includes(`${deleted} was deleted, so its plan row is stale; retire it: node bin/cells-plan.js --retire ${deleted}`),
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
  const before = readFileSync(join(root, 'bin/cells-plan.json'), 'utf8');
  const retire = runFixtureChild(process.execPath, [BIN, '--retire', 'src/claims.js'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(retire.status, 0);
  assert.match(retire.stderr, /CELLS_PLAN_RETIRED[\s\S]*live import/u);
  assert.equal(readFileSync(join(root, 'bin/cells-plan.json'), 'utf8'), before, 'a refused retirement writes nothing');
});
