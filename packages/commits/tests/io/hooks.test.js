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

test('commits.io-hooks.no-plan-shard-allowance: clause 1: a lane commit that adds a row for its own new file to a cells plan shard outside its lane is refused like any other foreign edit, with no new-file placement allowance [C7]', (t) => {
  const graph = fixtureCommittedGraph('pullboard-no-plan-allowance-'), root = graph.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const SHARD_PATH = 'packages/codemap/data/plan/01-x.json', shard = paths => JSON.stringify({ order: 1, name: 'x', root: 'packages/x', paths }) + '\n';
  graph.put('pullboard.json', JSON.stringify({ gate: 'true', laneMode: 'on', lanes: { web: { owns: ['web/'], specs: ['G1'] } } }) + '\n');
  graph.put(SHARD_PATH, shard([]));
  graph.commit();
  graph.put('web/new.js', 'export {};\n');
  graph.put(SHARD_PATH, shard([['src/new.js', 'web/new.js', 'rule']]));
  runFixtureSetupGit(['add', '-A'], { cwd: root });
  const problems = preCommitProblems({ root, isMain: false, agent: { agent_lane: 'web' },
    config: { protect: { blocked: [], allowed: [], secrets: false }, laneMode: 'on', lanes: { web: { owns: ['web/'], specs: ['G1'] } } },
    boardFile: join(root, 'board.sqlite'), approvedRowPorts: { checkLoosening: () => [] } });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /outside the web lane: packages\/codemap\/data\/plan\/01-x\.json/u);
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

/** A repository with one commit per message after a base commit; a message starting "Merge " is made as a merge commit. */
function messages(t, list) {
  const graph = fixtureCommittedGraph('pullboard-range-messages-'), root = graph.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  graph.put('a.txt', 'a\n');
  const base = graph.commit();
  const run = args => runFixtureSetupGit(['-c', 'user.name=Test Agent', '-c', 'user.email=agent@example.com', ...args], { cwd: root });
  for (const [index, message] of list.entries()) {
    if (message.startsWith('Merge ')) {
      run(['checkout', '-q', '-b', `side${index}`]);
      run(['commit', '-q', '--allow-empty', '-m', 'chore: side work']);
      run(['checkout', '-q', 'main']);
      run(['commit', '-q', '--allow-empty', '-m', 'chore: main work']);
      run(['merge', '-q', '--no-ff', '-m', message, `side${index}`]);
    } else run(['commit', '-q', '--allow-empty', '-m', message]);
  }
  return { root, range: `${base}..HEAD` };
}

test('commits.io-hooks.range-refuses-co-author-trailer: clause 1: a range check refuses a Co-Authored-By trailer in any commit of the range when noCoAuthor is on and passes it when off [C1,C7]', async t => {
  const { root, range } = messages(t, ['docs: note\n\nCo-Authored-By: Ada Example <ada@example.com>', 'chore: tidy']);
  const { checkRangeMessages } = await import('../../light.js');
  await assert.rejects(checkRangeMessages(root, range, { noCoAuthor: true }), error => error.code === 'CO_AUTHOR');
  await checkRangeMessages(root, range, { noCoAuthor: false });
});

test('commits.io-hooks.range-refuses-home-path: clause 2: a range check refuses a merge subject naming a home-folder path whatever the setting, passes a clean range, and never echoes the path [C1,C7]', async t => {
  const { checkRangeMessages } = await import('../../light.js');
  for (const [folder, name] of [['Users', 'ada'], ['home', 'bob']]) {
    const { root, range } = messages(t, ['feat: one', `Merge branch 'side' of /${folder}/${name}/work/repo`]);
    for (const noCoAuthor of [false, true]) {
      await assert.rejects(checkRangeMessages(root, range, { noCoAuthor }), error => {
        assert.equal(error.code, 'HOME_PATH');
        assert.ok(!String(error.message).includes(name) && !String(error.message).includes(`/${folder}/`));
        return true;
      });
    }
  }
  const clean = messages(t, ['feat: one', "Merge branch 'side' into main"]);
  await checkRangeMessages(clean.root, clean.range, { noCoAuthor: true });
});

test('commits.io-hooks.commit-msg-refuses-a-quote: clause 1: commitMsgProblems refuses a message whose subject or body quotes a name from rules.quotedNames, and passes the same message with quotedNames empty [C7,#11300]', async () => {
  const { commitMsgProblems } = await import('../../index.js');
  const rules = { types: ['chore'], maxHeader: 72, banned: [], requireIds: [], noEmoji: false, noCoAuthor: false, quotedNames: ['Sam'] };
  const spec = { rows: [] };
  const body = 'chore: tidy the notes\n\nSam wrote: "keep it short"\n';
  const refused = commitMsgProblems(body, { rules, spec });
  assert.equal(refused.length, 1);
  assert.match(refused[0], /line \d+ quotes a configured person/u);
  assert.equal(commitMsgProblems('chore: sam said "tidy" the notes\n', { rules, spec }).length, 1);
  assert.deepEqual(commitMsgProblems(body, { rules: { ...rules, quotedNames: [] }, spec }), []);
  assert.deepEqual(commitMsgProblems('chore: tidy the notes\n\nSam reviewed it.\n', { rules, spec }), []);
});

/** A fixture repo whose base commit holds an older quoting line; the staged change adds `line` to a second file. */
function quotingChange(t, line) {
  const graph = fixtureCommittedGraph('pullboard-quoted-names-'), root = graph.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  graph.put('notes/old.txt', 'Sam said "an older line"\n');
  graph.put('notes/new.txt', 'plain\n');
  graph.commit();
  graph.put('notes/new.txt', `plain\n${line}\n`);
  runFixtureSetupGit(['add', '-A'], { cwd: root });
  return root;
}

/** The pre-commit refusals for that staged change with the given quoted names. */
function quotingProblems(root, quotedNames) {
  return preCommitProblems({ root, isMain: true, agent: null, config: { protect: { blocked: [], allowed: [], secrets: false }, commits: { quotedNames } },
    approvedRowPorts: { checkLoosening: () => [] } });
}

test('commits.io-hooks.pre-commit-refuses-an-added-quote: clause 1: with commits.quotedNames Sam, a staged added line quoting Sam is refused naming file and line; an unchanged older line and the same line with no names pass [C7,#11301]', t => {
  const quote = 'Sam said "ship it"';
  const root = quotingChange(t, quote);
  const problems = quotingProblems(root, ['Sam']);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /^notes\/new\.txt:2 quotes a configured person/u);
  assert.deepEqual(quotingProblems(root, []), []);
  const older = quotingChange(t, 'a plain added line');
  assert.deepEqual(quotingProblems(older, ['Sam']), []);
});
