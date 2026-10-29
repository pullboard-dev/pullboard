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
  assert.deepEqual(lines, ['6', '2', 'bin/cells-plan.json'], 'one counter and one appended object, without a formatting rewrite');
  for (const [file, bytes] of shards) assert.equal(readFileSync(join(root, file), 'utf8'), bytes, `${file} keeps its compact shard format`);
});
