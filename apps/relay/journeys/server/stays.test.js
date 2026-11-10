/** @pullboard-test-input source-tree */
/** @pullboard-test-input source-tree packages/codemap/data/plan/cells.json packages/codemap/data/plan/** */
/** A stay may name its owner cell: the file keeps its path, and cuts count it as that cell's file [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { placePath } from '../../../../packages/codemap/index.js';
import { readPlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { checkCuts } from '../../../../packages/codemap/src/io/cells/plan/cuts.js';
import { ownedStayProblems } from '../../../../packages/codemap/index.js';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { runFixtureChild } from '../../../cli/tests/fixtures/child.js';

const BIN = fileURLToPath(new URL('../../../../packages/codemap/src/io/cells/scripts/plan.js', import.meta.url));
const SERVER = "import { serve } from '../apps/relay/index.js';\nserve();\n";

/** A lower cell's file imports a deployed entry that stays at relay/server.mjs and imports the later app cell. */
function box(t) {
  const value = fixture(t), { root, put } = value;
  put('relay/server.mjs', SERVER);
  put('apps/relay/index.js', 'export function serve() { return 1; }\n');
  put('src/caller.js', "import '../relay/server.mjs';\nexport const caller = 1;\n");
  git(root, 'add', '-A');
  /** A cell's complete row data is kept independent of the plan reader's derived counters. */
  const cell = (name, order, root, paths) => ({ name, order, kind: name.startsWith('app:') ? 'app' : 'package',
    root, frontDoor: `${root}/index.js`, paths, reexports: [], imports: [], cuts: [], ratchets: {}, item: { after: [] } });
  writePlan(root, { version: 1, base: git(root, 'rev-parse', 'HEAD').trim(),
    cells: [cell('low', 1, 'packages/low', [['src/caller.js', 'packages/low/src/shell/caller.js', 'rule']]),
      cell('app:relay', 2, 'apps/relay', [])],
    stays: [{ path: 'relay/server.mjs', reason: 'deployed relay entry keeps its path' }] });
  return value;
}

test('an owned stay imported by a lower cell is a cut into its owner, and the file keeps its path [C7]', t => {
  const { root } = box(t);
  const unowned = checkCuts(root, readPlan(root), 'low', { allLaterCells: true });
  assert.ok(unowned.some(problem => problem.includes('relay/server.mjs -> apps/relay/index.js')), unowned.join('\n'));
  const result = runFixtureChild(process.execPath, [BIN, '--stay', 'relay/server.mjs', '--owner', 'app:relay'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const plan = readPlan(root);
  assert.deepEqual(plan.stays.filter(row => row.path === 'relay/server.mjs'),
    [{ path: 'relay/server.mjs', reason: 'deployed relay entry keeps its path', owner: 'app:relay' }]);
  assert.equal(plan.cells.flatMap(cell => cell.paths).filter(row => row[0] === 'relay/server.mjs').length, 0, 'the stay is not planned to move');
  assert.equal(readFileSync(join(root, 'relay/server.mjs'), 'utf8'), SERVER);
  assert.deepEqual(ownedStayProblems(plan), []);
  assert.deepEqual(checkCuts(root, plan, 'low', { allLaterCells: true }),
    ['low still imports later app:relay: src/caller.js -> relay/server.mjs']);
  assert.deepEqual(checkCuts(root, plan, 'app:relay', { allLaterCells: true }), [], 'the owner may import its own front door');
});

test('an owner must be an existing cell, and only a stay can have one [C7]', t => {
  const { root } = box(t);
  assert.throws(() => placePath(root, 'relay/server.mjs', { stay: true, owner: 'app:none' }), error => error.code === 'CELLS_STAY_OWNER');
  assert.throws(() => placePath(root, 'src/caller.js', { stay: true, owner: 'app:relay' }), error => error.code === 'CELLS_STAY_OWNER');
  assert.throws(() => placePath(root, 'relay/server.mjs', { cell: 'app:relay', owner: 'app:relay' }), error => error.code === 'CELLS_STAY_OWNER');
  const plan = readPlan(root);
  plan.stays[0].owner = 'app:none';
  assert.deepEqual(ownedStayProblems(plan), ['stay relay/server.mjs names owner "app:none", which is not a cell in the plan']);
  assert.throws(() => writePlan(root, plan), error => error.code === 'CELLS_STAY_OWNER');
  placePath(root, 'relay/server.mjs', { stay: true, owner: 'app:relay' });
  assert.throws(() => placePath(root, 'relay/server.mjs', { stay: true, owner: 'low' }), error => error.code === 'CELLS_STAY_OWNER');
});
