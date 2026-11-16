/** @pullboard-world-pin builds a real git repository in a private root and a real SQLite shout table; the board reads are explicit ports. */
/** A main-move conflict warning shouts once per item head and file, not again on every main move [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { warnMainMoved } from '../index.js';
import { privateFixtureFiles } from '../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../apps/cli/tests/fixtures/child.js';

/**
 * A repository whose main moves, a submitted item head that conflicts with every move, and a shout table.
 *
 * @param {import('node:test').TestContext} t - Test context that removes the fixture.
 * @returns {object} Helpers: move main, set the item head, warn, and read the shouts.
 */
function fixture(t, extra = []) {
  const tree = privateFixtureFiles('pb-main-warn-');
  t.after(() => rmSync(tree.root, { recursive: true, force: true }));
  const root = join(tree.root, 'repo');
  /** Run git in the fixture with a fixed identity. */
  const git = (...args) => runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: root });
  for (const file of ['a.txt', 'b.txt', ...extra]) tree.write(`repo/${file}`, 'base\n');
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE shout (shout_to TEXT, shout_from TEXT, shout_text TEXT)');
  const board = { db };
  const state = { head: null };
  /** Commit conflicting edits of the named files on a branch off base and return its commit. */
  const branch = (name, files, text) => {
    git('checkout', '-q', '-b', name, base);
    for (const file of files) tree.write(`repo/${file}`, `${text}\n`);
    git('commit', '-q', '-am', name);
    const commit = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    return commit;
  };
  /** Land one more commit on main that touches the named files. */
  const moveMain = (files, text) => {
    for (const file of files) tree.write(`repo/${file}`, `${text}\n`);
    git('commit', '-q', '-am', `main ${text}`);
    return git('rev-parse', 'HEAD');
  };
  const reads = {
    listAgents: () => [],
    listItems: () => [{ item_id: 7, item_status: 'submitted', item_commit: state.head, item_merged_commit: null }],
  };
  const write = async (_operation, [shout]) => { db.prepare('INSERT INTO shout VALUES (?, ?, ?)').run(shout.to, shout.from, shout.text); };
  return {
    branch,
    moveMain,
    state,
    /** Observe a main move to `trunk` the way a landing does. */
    warn: trunk => warnMainMoved({ root, board, trunk, write, say: () => {} }, reads),
    shouts: () => db.prepare('SELECT shout_text FROM shout').all().map(row => row.shout_text),
  };
}

test('clause 1: warnMainMoved writes one shout for an item head and file, and a later main move with the same head and file writes none [C7]', async (t) => {
  const box = fixture(t);
  box.state.head = box.branch('item', ['a.txt'], 'item');
  await box.warn(box.moveMain(['a.txt'], 'first'));
  assert.equal(box.shouts().length, 1);
  await box.warn(box.moveMain(['a.txt'], 'second'));
  assert.equal(box.shouts().length, 1, 'a different trunk sha does not make the same head and file a new warning');
});

test('clause 2: a new item head, or a newly conflicting file, writes a new shout [C7]', async (t) => {
  const box = fixture(t);
  box.state.head = box.branch('item', ['a.txt', 'b.txt'], 'item');
  await box.warn(box.moveMain(['a.txt'], 'first'));
  assert.equal(box.shouts().length, 1);
  await box.warn(box.moveMain(['b.txt'], 'second'));
  assert.equal(box.shouts().length, 2, 'a newly conflicting file is told');
  box.state.head = box.branch('item-two', ['a.txt'], 'item two');
  await box.warn(box.moveMain(['a.txt'], 'third'));
  assert.equal(box.shouts().length, 3, 'a new item head is told');
});

/** A path of exactly `length` characters in slash-separated segments, letters at both ends so pieces join without doubled slashes. */
function longName(length, letter) {
  const chars = Array.from({ length }, (_, index) => (index % 50 === 49 && index !== length - 1 ? '/' : letter));
  return chars.join('');
}

test('clause 1: two long paths that share a piece are told apart, so a newly conflicting long path is never silent [C7]', async (t) => {
  const W = 400 - '#7 main moved to 123456789abc; 123456789abc conflicts in '.length - '; git merge main in your worktree, resolve, commit and resubmit'.length - 30;
  const head = longName(W - 1, 'p');
  const tail = longName(W - 1, 't');
  // A and C each use one of B's two pieces; B reuses the first piece of A and the second piece of C.
  const A = `${head}${longName(W - 1, 'a')}`, C = `${longName(W - 1, 'c')}${tail}`, B = `${head}${tail}`;
  const box = fixture(t, [A, B, C]);
  box.state.head = box.branch('item', [A, B, C], 'item');
  await box.warn(box.moveMain([A, C], 'first'));
  const told = box.shouts().length;
  assert.ok(told >= 4, 'each long path is told in more than one piece');
  await box.warn(box.moveMain([B], 'second'));
  assert.ok(box.shouts().length > told, 'a path built from pieces already told is still a new warning');
  await box.warn(box.moveMain([B], 'third'));
  assert.equal(box.shouts().length, told + 2, 'the same long path is not told again');
});
