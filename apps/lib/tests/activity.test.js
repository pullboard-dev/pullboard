/** Native claim maintenance distinguishes a silent editor from an abandoned item folder [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBoard } from '../index.js';
import * as store from '../../../packages/store/index.js';
import { captureLapsedClaims } from '../../../packages/health/index.js';
import { runFixtureGit } from '../../cli/tests/fixtures/child.js';

/** Real item worktree and SQLite board, with baseline timestamps older than the activity window. */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-seat-edit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'seat');
  mkdirSync(root);
  let now = Date.now() - 20 * 60_000;
  const old = new Date(now);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_AUTHOR_DATE: old.toISOString(), GIT_COMMITTER_DATE: old.toISOString() };
  /** Run actual Git operations in the fixture's own repositories. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'work.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'fixture');
  const board = openBoard(join(dir, 'board.sqlite'), { now: () => new Date(now) });
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: join(dir, 'coordinator') });
  const holder = store.register(board, { lane: 'core', path: root, route: 'strong' });
  const helper = store.register(board, { lane: 'core', path: join(dir, 'helper'), route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Work', criterion: 'Work' });
  store.claim(board, id, { agentId: holder, lane: 'core', leaseMs: 7_200_000,
    freeze: () => ({ text: 'Work', digest: 'bar' }) });
  const itemRoot = `${root}-item-${id}`;
  git(root, 'worktree', 'add', '-q', '--detach', itemRoot);
  const log = git(itemRoot, 'rev-parse', '--git-path', 'logs/HEAD').trim();
  for (const path of [join(root, 'work.txt'), join(root, '.git/logs/HEAD'), join(itemRoot, 'work.txt'), log]) utimesSync(path, old, old);
  now = Date.now() + 5_000;
  /** Exercise both ordinary writes and the full background maintenance capture. */
  const capture = lapsedOnly => captureLapsedClaims({ clock: { now: () => new Date(now) }, config: {} }, board, helper, { lapsedOnly });
  return { root, itemRoot, log, board, holder, helper, id, git, capture };
}

for (const lapsedOnly of [true, false]) {
  test(`recent item-folder edits protect a silent seat on ${lapsedOnly ? 'ordinary' : 'background'} maintenance [B4,C7]`, t => {
    const f = fixture(t);
    writeFileSync(join(f.itemRoot, 'work.txt'), 'editing\n');
    assert.equal(f.capture(lapsedOnly)?.claims.some(row => row.id === f.id) ?? false, false);
    assert.equal(store.getItem(f.board, f.id).item_owner, f.holder);
  });
  test(`a recent item-folder commit protects a silent seat on ${lapsedOnly ? 'ordinary' : 'background'} maintenance [B4,C7]`, t => {
    const f = fixture(t);
    f.git(f.itemRoot, 'commit', '-q', '--allow-empty', '-m', 'actual empty commit');
    assert.equal(f.capture(lapsedOnly)?.claims.some(row => row.id === f.id) ?? false, false);
  });
  test(`a seat whose own board event is under two minutes old keeps its claim on ${lapsedOnly ? 'ordinary' : 'background'} maintenance [B4,C7]`, t => {
    // Its presence heartbeat is stale (no hook, or a busy presence file), but the board shows it running commands.
    const f = fixture(t);
    store.logEvent(f.board, f.holder, 'fact', f.id, { id: 'still-working', kind: 'note', text: 'running the tests', ref: null, supersedes: null });
    const snapshot = f.capture(lapsedOnly);
    assert.equal(snapshot?.claims.some(row => row.id === f.id && row.idle === 'seat-gone') ?? false, false);
    assert.equal(store.getItem(f.board, f.id).item_owner, f.holder);
  });
  test(`a silent seat with no item-folder change for fifteen minutes is reclaimed on ${lapsedOnly ? 'ordinary' : 'background'} maintenance [B4,C7]`, t => {
    const f = fixture(t);
    const snapshot = f.capture(lapsedOnly);
    assert.equal(snapshot.claims.find(row => row.id === f.id)?.idle, 'seat-gone');
    store.maintainStaleState(f.board, { agentId: f.helper, snapshot, health: {}, claimsOnly: true });
    assert.equal(store.getItem(f.board, f.id).item_status, 'open');
  });
}
