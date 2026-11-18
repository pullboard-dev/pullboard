/** @pullboard-test-input source-cell packages/commits */
/** The pre-commit shared reads answer each cells plan shard as one record, however many paths a commit stages [C7,#10657]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureSetupGit } from '../../../gate/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../gate/tests/fixtures/testkit.js';
import { preCommitProblems } from '../../index.js';

const PLAN = 'packages/codemap/data/plan/cells.json';
const SHARD = 'packages/codemap/data/plan/32-api.json';

/**
 * A repository whose staged change edits `fillers` files that sort before the plan folder, plus the plan shard,
 * so with over 400 fillers the shard falls in a later batch than the plan folder listing (the RW1 merge shape).
 */
function staged(t, fillers) {
  const graph = fixtureCommittedGraph('pullboard-shard-reads-'), root = graph.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  graph.put(PLAN, JSON.stringify({ cells: [{ file: SHARD }] }));
  graph.put(SHARD, '{"cell":"api","paths":[]}\n');
  for (let index = 0; index < fillers; index++) graph.put(`a/f${index}.js`, `export const value = ${index};\n`);
  graph.commit();
  graph.put(SHARD, '{"cell":"api","paths":[],"changed":true}\n');
  for (let index = 0; index < fillers; index++) graph.put(`a/f${index}.js`, `export const value = ${index + 1};\n`);
  runFixtureSetupGit(['add', '-A'], { cwd: root });
  return root;
}

/** Run the real pre-commit with a shim port that only records what its read port returns for the plan files. */
function shardReads(root) {
  const seen = {};
  const problems = preCommitProblems({ root, isMain: true, agent: null, config: { protect: { blocked: [], allowed: [], secrets: false } },
    // No spec or doctrine file is staged, so the approved-row check never calls its port.
    approvedRowPorts: { checkLoosening: () => [] },
    shimImports: ({ read }) => {
      for (const revision of ['HEAD', ':index']) seen[revision] = { plan: read(revision, PLAN), shard: read(revision, SHARD) };
      return [];
    } });
  return { problems, seen };
}

test('commits.io-hooks.shard-read-past-400-paths: clause 1: preCommitProblems on a staged change of more than 400 paths that includes a cells plan shard hands its shimImports port a read that returns that shard\'s bytes at HEAD and at the index, not undefined [C7]', (t) => {
  const { problems, seen } = shardReads(staged(t, 450));
  assert.deepEqual(problems, []);
  assert.equal(seen.HEAD.shard, '{"cell":"api","paths":[]}\n');
  assert.equal(seen[':index'].shard, '{"cell":"api","paths":[],"changed":true}\n');
  assert.equal(seen[':index'].plan, JSON.stringify({ cells: [{ file: SHARD }] }));
});

test('commits.io-hooks.shard-read-small-commit: clause 2: a staged change under 400 paths still reads each plan file as one record, so the shared listing is unchanged for small commits [C7]', (t) => {
  const { problems, seen } = shardReads(staged(t, 3));
  assert.deepEqual(problems, []);
  assert.equal(seen.HEAD.shard, '{"cell":"api","paths":[]}\n');
  assert.equal(seen[':index'].shard, '{"cell":"api","paths":[],"changed":true}\n');
  assert.equal(seen.HEAD.plan, JSON.stringify({ cells: [{ file: SHARD }] }));
});

const BRIEF = 'Slice.\nFiles:\n- packages/alpha/src/a.js\n- packages/alpha/tests/a.test.js\nCaller files: packages/beta/src/b.js:3.\n';

/** A seat in lane web whose claimed item names two packages/alpha files; the staged change edits the given paths. */
function laneChange(t, laneMode, edited) {
  const graph = fixtureCommittedGraph('pullboard-lanes-off-'), root = graph.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  graph.put('pullboard.json', JSON.stringify({ gate: 'true', laneMode, lanes: { web: { owns: ['web/'], specs: ['G1'] } } }) + '\n');
  for (const path of ['packages/alpha/src/a.js', 'packages/alpha/tests/a.test.js', 'packages/beta/src/b.js']) graph.put(path, 'original\n');
  graph.commit();
  for (const path of edited) graph.put(path, 'edited\n');
  runFixtureSetupGit(['add', '-A'], { cwd: root });
  const claimed = [{ item_brief: BRIEF, item_files: '' }];
  const board = { prepare: () => ({ all: () => claimed }), close: () => {} };
  return preCommitProblems({ root, isMain: false, agent: { agent_lane: 'web', agent_id: 'seat-1' }, boardFile: join(root, 'board.sqlite'),
    config: { protect: { blocked: [], allowed: [], secrets: false } }, approvedRowPorts: { checkLoosening: () => [], openBoardReadOnly: () => board } });
}

test('commits.io-hooks.lanes-off-own-cells-pass: clause 1: with laneMode off a staged change touching only the cells of the claimed item\'s named files passes [C7,#8907]', t => {
  assert.deepEqual(laneChange(t, 'off', ['packages/alpha/src/a.js', 'packages/alpha/tests/a.test.js']), []);
});

test('commits.io-hooks.lanes-off-foreign-cell-refused: clause 2: with laneMode off a staged path outside those cells is refused naming the path [C7,#8907]', t => {
  const problems = laneChange(t, 'off', ['packages/alpha/src/a.js', 'packages/beta/src/b.js']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /outside the web lane: packages\/beta\/src\/b\.js/u);
});

test('commits.io-hooks.lanes-on-unchanged: clause 2: with laneMode on the named cells are not owned and the lane folders decide [C7,#8907]', t => {
  const problems = laneChange(t, 'on', ['packages/alpha/src/a.js']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /outside the web lane: packages\/alpha\/src\/a\.js/u);
});

/** A linked worktree named like an item folder of #7, checked out on `branch`, with one staged change. */
function itemFolder(t, branch) {
  const graph = fixtureCommittedGraph('pullboard-item-folder-'), main = graph.root, root = `${main}-item-7`;
  t.after(() => rmSync(main, { recursive: true, force: true }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  graph.put('pullboard.json', JSON.stringify({ gate: 'true', laneMode: 'on', lanes: { core: { owns: ['a.txt'], specs: ['G1'] } } }) + '\n');
  graph.put('a.txt', 'original\n');
  graph.commit();
  runFixtureSetupGit(['worktree', 'add', '-b', branch, root], { cwd: main });
  writeFileSync(join(root, 'a.txt'), 'edited\n');
  runFixtureSetupGit(['add', '-A'], { cwd: root });
  return root;
}

const FOLDER_OPTIONS = { isMain: false, boardFile: 'board.sqlite', config: { protect: { blocked: [], allowed: [], secrets: false } }, approvedRowPorts: { checkLoosening: () => [] } };

test('commits.io-hooks.item-folder-off-branch-refused: clause 1: a commit in a claimed item folder whose HEAD is on probe/7 is refused with ITEM_FOLDER_OFF_BRANCH, not NOT_JOINED, and says to switch back or probe elsewhere [C7,#10799]', (t) => {
  const problems = preCommitProblems({ ...FOLDER_OPTIONS, root: itemFolder(t, 'probe/7'), agent: null });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^ITEM_FOLDER_OFF_BRANCH: /u);
  assert.match(problems[0], /switch back to <lane>\/item-7, or probe in a separate worktree/u);
  assert.doesNotMatch(problems[0], /not joined/u);
});

test('commits.io-hooks.item-folder-own-branch-passes: clause 2: a commit on core/item-7 in that folder, resolved to its claiming seat, passes as today [C7,#10799]', (t) => {
  assert.deepEqual(preCommitProblems({ ...FOLDER_OPTIONS, root: itemFolder(t, 'core/item-7'), agent: { agent_lane: 'core', agent_id: 'seat-1' } }), []);
});

test('commits.io-hooks.unjoined-worktree-unchanged: clause 2: a checkout that is not an item folder and has no seat still says it has not joined a lane [C7,#10799]', (t) => {
  const graph = fixtureCommittedGraph('pullboard-unjoined-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  graph.put('a.txt', 'original\n');
  graph.commit();
  graph.put('a.txt', 'edited\n');
  runFixtureSetupGit(['add', '-A'], { cwd: graph.root });
  assert.deepEqual(preCommitProblems({ ...FOLDER_OPTIONS, root: graph.root, agent: null }), ['this worktree has not joined a lane: pullboard join <lane> --model "<model name>"']);
});
