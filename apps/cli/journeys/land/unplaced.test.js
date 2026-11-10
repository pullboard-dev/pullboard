/** Landing refuses a merged tree that adds a bin/ or src/ path with no cells-plan row, before main moves [C7,#3210]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { placedMerge } from '../../../../packages/landing/index.js';
import { addedPlacementProblems } from '../../../../packages/codemap/src/io/cells/plan/cuts.js';
import {
  readPlan,
  unplanned,
  writePlan,
} from '../../../../packages/codemap/src/io/cells/scripts/plan.js';
import {
  fixture,
  git,
} from '../../../../packages/landing/tests/fixtures/plan.js';

/** A placed base repository and a second worktree whose commit adds one source file without a plan row. */
function merged(t, path = 'src/added.js') {
  const { root, put } = fixture(t);
  const plan = { version: 1, base: git(root, 'rev-parse', 'HEAD').trim(), cells: [], stays: [] };
  const all = git(root, 'ls-files').split('\n').filter(file => /^(?:src|bin)\/.+\.js$/u.test(file));
  plan.stays = all.map(file => ({ path: file, reason: 'fixture stays' }));
  writePlan(root, plan);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'plan');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  const tree = `${root}-merged`;
  git(root, 'worktree', 'add', '-q', '-b', 'item', tree, base);
  mkdirSync(dirname(join(tree, path)), { recursive: true });
  writeFileSync(join(tree, path), 'export const added = true;\n');
  git(tree, 'add', '-A');
  git(tree, 'commit', '-q', '-m', 'adds an unplaced file');
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  return { root, tree, base, commit: git(tree, 'rev-parse', 'HEAD').trim(), put };
}

test('clause 1: a merged tree that adds src/added.js with no plan row is refused naming the path and the item returns to its builder [C7,#3210]', async t => {
  const { root, tree, base, commit } = merged(t);
  assert.deepEqual(addedPlacementProblems(root, root, { unplanned, readPlan }), []);
  assert.deepEqual(addedPlacementProblems(root, tree, { unplanned, readPlan }).map(row => row.path), ['src/added.js']);
  const board = openBoard(':memory:', { now: () => new Date('2026-11-06T10:10:00.000Z') });
  t.after(() => store.closeBoard(board));
  const calls = [], said = [];
  const state = { root, board, culprits: [], say: line => said.push(line), batch: { id: 'batch', root: tree, base, tip: commit, revision: 0 },
    write: async (operation, [argument]) => { calls.push(operation); return argument.batch ?? state.batch; } };
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'adds an unplaced file' });
  assert.equal(await placedMerge(state, [{ id, commit }]), false);
  assert.deepEqual(state.culprits.map(culprit => culprit.id), [id]);
  assert.match(said.join('\n'), /src\/added\.js has no cells-plan row/u);
  assert.match(state.culprits[0].tests[0].name, /CELLS_PLAN_UNPLACED/u);
});

test('clause 1: a merged tree that adds nothing unplaced lands on [C7,#3210]', async t => {
  const { root, tree, base, commit } = merged(t);
  git(tree, 'rm', '-q', 'src/added.js');
  git(tree, 'commit', '-q', '-m', 'drop it');
  const state = { root, culprits: [], say() {}, batch: { id: 'batch', root: tree, base, revision: 0 }, write: async () => assert.fail('nothing is saved') };
  assert.equal(await placedMerge(state, [{ id: 1, commit }]), true);
});
