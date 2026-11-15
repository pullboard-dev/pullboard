/** Claim worktrees are observed from Git once, recorded for later reads, and named as overlaps; landed commits name their changed files [N2,B3,R2,C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';
import { activityMainFiles } from '../../index.js';
import { batchMainFiles } from '../../index.js';
import { claimOverlapLines } from '../../index.js';
import { claimWorktrees } from '../../index.js';
import { fileChangeWaiter } from '../../index.js';
import { recordClaimWorktrees } from '../../index.js';
import { recordedClaimWorktrees } from '../../index.js';

/** A repo holding shared.js at a base commit and two detached worktrees of it, each editing shared.js its own way. */
function twoWorktrees(t) {
  const repo = cellRepo(t, { real: true });
  repo.put('shared.js', 'old\n');
  const base = repo.commitAll();
  const scratch = privateFixtureFiles('pullboard-worktrees-');
  const first = join(scratch.root, 'first');
  const second = join(scratch.root, 'second');
  for (const folder of [first, second]) runFixtureGit(['-C', repo.root, 'worktree', 'add', '-q', '--detach', folder, base]);
  writeFileSync(join(first, 'shared.js'), 'first\n');
  writeFileSync(join(second, 'shared.js'), 'second\n');
  const items = [
    { item_id: 1, item_status: 'claimed', item_owner: 'one', item_claim_head: base },
    { item_id: 2, item_status: 'claimed', item_owner: 'two', item_claim_head: base },
    { item_id: 3, item_status: 'claimed', item_owner: 'ghost', item_claim_head: base },
    { item_id: 4, item_status: 'open' },
  ];
  const agents = [{ agent_id: 'one', agent_path: first }, { agent_id: 'two', agent_path: second }];
  return { repo, base, first, second, items, agents };
}

test('each claimed seat\'s worktree is read from Git against its claim base, and a seat with no checkout reads unknown [N2]', t => {
  const { items, agents, first } = twoWorktrees(t);
  const seen = claimWorktrees(items, agents);
  assert.deepEqual([...seen.keys()], [1, 2, 3], 'only claimed items are observed');
  assert.deepEqual(seen.get(1), { files: ['shared.js'], unknown: false });
  assert.deepEqual(seen.get(2), { files: ['shared.js'], unknown: false });
  assert.deepEqual(seen.get(3), { files: [], unknown: true });
  runFixtureGit(['-C', first, 'config', 'user.name', 'Fixture']);
  runFixtureGit(['-C', first, 'config', 'user.email', 'fixture@example.test']);
  runFixtureGit(['-C', first, 'commit', '-qam', 'edit shared']);
  writeFileSync(join(first, 'new.js'), 'untracked\n');
  assert.deepEqual(claimWorktrees(items, agents).get(1).files.sort(), ['new.js', 'shared.js'], 'committed, edited and untracked files all count');
  assert.equal(claimWorktrees([{ ...items[0], item_claim_head: 'not-a-commit' }], agents).get(1).unknown, true, 'an unusable claim base is unknown, never zero');
});

test('overlap lines name a shared edit and an out-of-scope edit to the holder only, and an unobserved claim is named unknown [N2]', t => {
  const { items, agents } = twoWorktrees(t);
  const project = () => new Map([[1, { overlaps: [{ item: 2, builder: 'two', files: ['shared.js'] }], outOfScope: [{ item: 4, files: ['a.js', 'b.js'] }], unknown: false }],
    [2, { overlaps: [], outOfScope: [], unknown: true }]]);
  const observations = new Map([[1, { files: ['shared.js'], unknown: false }], [2, { files: [], unknown: true }]]);
  assert.deepEqual(claimOverlapLines(items, agents, 'one', project, observations), ['#1 overlaps #2 (two) on shared.js', '#1 may be out of scope: #4 names a.js, b.js']);
  assert.deepEqual(claimOverlapLines(items, agents, 'two', project, observations), ['#2 worktree changes are unavailable; overlap is unknown']);
  assert.deepEqual(claimOverlapLines(items, agents, 'two', project, new Map([[2, { files: [], unknown: true, unrecorded: true }]])), [], 'a claim maintenance has not observed says nothing');
  assert.deepEqual(claimOverlapLines(items, agents, 'nobody', () => assert.fail('no claim, no projection')), []);
});

test('background maintenance records each claim\'s files, and a later read answers from the record with no Git [N2,B3]', t => {
  const { repo, items, agents, first } = twoWorktrees(t);
  const board = cellBoard(t, repo.boardFile, undefined, { real: true });
  const observed = recordClaimWorktrees(board, items, agents, { now: new Date('2026-11-09T12:00:00.000Z') });
  assert.deepEqual(observed.get(1), { files: ['shared.js'], unknown: false });
  const recorded = recordedClaimWorktrees(items, agents, board);
  assert.deepEqual(recorded.get(1), { files: ['shared.js'], unknown: false });
  assert.deepEqual(recorded.get(3), { files: [], unknown: true });
  writeFileSync(join(first, 'later.js'), 'edited after the record\n');
  assert.deepEqual(recordedClaimWorktrees(items, agents, board).get(1).files, ['shared.js'], 'the record does not run Git');
  assert.deepEqual(recordedClaimWorktrees(items, agents, board, { own: first }).get(1).files.sort(), ['later.js', 'shared.js'], 'a seat\'s own claim is observed live');
  const moved = recordedClaimWorktrees([{ ...items[0], item_claim_head: 'b'.repeat(40) }], agents, board);
  assert.deepEqual(moved.get(1), { files: [], unknown: true, unrecorded: true }, 'a record for another claim head is not this claim\'s');
  assert.deepEqual(recordedClaimWorktrees(items, agents, null).get(1), { files: [], unknown: true, unrecorded: true });
});

test('a landed commit names the files it changed against its base, and an unreadable pair is unknown [R2,N26]', t => {
  const repo = cellRepo(t, { real: true });
  repo.put('a.txt', 'one\n');
  const first = repo.commitAll();
  repo.put('b.txt', 'two\n');
  const second = repo.commitAll();
  repo.put('a.txt', 'three\n');
  const third = repo.commitAll();
  assert.deepEqual(activityMainFiles(repo.root, second, { base: first }), { files: ['b.txt'], rows: [], unknownRows: false });
  assert.equal(activityMainFiles(repo.root, 'short', { base: first }), null);
  assert.equal(activityMainFiles(repo.root, 'f'.repeat(40), { base: first }), null, 'a missing object is unknown, never zero');
  const batch = batchMainFiles(repo.root, [{ base: first, commit: second }, { base: second, commit: third }, { base: 'bad', commit: third }]);
  assert.deepEqual([...batch.entries()], [[`${first} ${second}`, ['b.txt']], [`${second} ${third}`, ['a.txt']]]);
  assert.equal(batchMainFiles(repo.root, [{ base: first, commit: second }]).size, 0, 'one pair needs no batch');
  assert.deepEqual(activityMainFiles(repo.root, second, { base: first }, { batch }), { files: ['b.txt'], rows: [], unknownRows: false });
});

test('the file waiter wakes on a change made before it sleeps, honours a past deadline, and settles on close [C7]', async t => {
  const scratch = privateFixtureFiles('pullboard-waiter-');
  const file = join(scratch.root, 'watched.txt');
  writeFileSync(file, 'one\n');
  const waiter = fileChangeWaiter([file]);
  t.after(() => waiter.close());
  const before = waiter.version();
  writeFileSync(file, 'two, and longer\n');
  await waiter.wait({ after: before, deadline: Date.now() + 20_000 });
  assert.ok(waiter.version() > before, 'the edit was seen, not the deadline');
  const settled = waiter.version();
  await waiter.wait({ after: settled, deadline: Date.now() - 1 });
  assert.equal(waiter.version(), settled, 'a deadline already past returns without a change');
  const pending = waiter.wait({ after: settled });
  waiter.close();
  await pending;
});
