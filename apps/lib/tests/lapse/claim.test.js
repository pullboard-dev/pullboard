/** A claim on a coordinator-pinned item with no real work for 30 minutes lapses to open; other claims keep 40 [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../index.js';
import { saveAgentSession } from '../../../../packages/seats/index.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';
import { captureLapsedClaims } from '../../../../packages/health/index.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
for (const key of Object.keys(ENV)) if (key.startsWith('GIT_') && !/^(?:GIT_CONFIG_|GIT_AUTHOR_|GIT_COMMITTER_)/u.test(key)) delete ENV[key];

/** A real repository with one worktree per seat, an in-memory board on a clock the test advances, and a private machine home. */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-claim-hygiene-')));
  const previousHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  t.after(() => {
    if (previousHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env: ENV });
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: base');
  const base = git(repo, 'rev-parse', 'HEAD');
  let at = Date.now() + 60_000;
  const board = openBoard(':memory:', { now: () => new Date(at) });
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: repo });
  const worktrees = {};
  /** Join a seat in its own real worktree, under the named runtime session. */
  const seat = (name, session) => {
    const path = join(dir, name);
    git(repo, 'worktree', 'add', '-q', '--detach', path, 'main');
    const id = store.register(board, { lane: 'core', path, route: 'strong' });
    saveAgentSession(board, id, session.repeat(64));
    worktrees[id] = path;
    return id;
  };
  const first = seat('first', '1'), second = seat('second', '3'), helper = seat('helper', '2');
  const add = (after = []) => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Work', criterion: 'Real proof', specIds: ['B5'], route: 'strong', check: 'true', after });
  const claim = (id, agentId, submitOutcome = null) => store.claim(board, id, { agentId, lane: 'core', leaseMs: 7_200_000, head: base, submitOutcome,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, rows: [], policy: { version: 1, commit: base, verify: { policy: 'any', family: 'off' } } }), digest: 'bar' }) });
  const ctx = { clock: { now: () => new Date(at) }, config: {} };
  /** One ordinary write by another seat runs the same maintenance every board write runs. */
  const maintain = (actor = helper) => {
    // The holders are live seats that keep heartbeating, so only their work, never their presence, ages a claim (#3447).
    for (const id of [first, second]) store.heartbeatSeat(board, id);
    const snapshot = captureLapsedClaims(ctx, board, actor);
    if (snapshot) store.maintainStaleState(board, { agentId: actor, snapshot, health: {}, claimsOnly: true });
    return snapshot;
  };
  /** A real file change in a seat's worktree, stamped at the board clock. */
  const touch = (agent, file) => {
    writeFileSync(join(worktrees[agent], file), `${at}\n`);
    utimesSync(join(worktrees[agent], file), new Date(at), new Date(at));
  };
  return { board, git, repo, base, worktrees, first, second, helper, seat, add, claim, maintain, touch,
    now: () => at, advance: minutes => { at += minutes * 60_000; } };
}


/** Record a coordinator pin (a ranked item with a reason) for each id in one milestone. */
function pin(board, ids, name = 'Now') {
  board.db.prepare('INSERT OR REPLACE INTO board_meta(meta_key,meta_value) VALUES (?,?)').run('milestones',
    JSON.stringify([{ name, items: ids, order: ids, reasons: Object.fromEntries(ids.map(id => [String(id), 'blocks the order'])) }]));
}

test('lib.lapse-claim.a-claim-on-a-pinned-item: a claim on a pinned item idle for 30 minutes lapses to open [C7]', t => {
  const f = fixture(t);
  const a = f.add();
  pin(f.board, [a]);
  f.claim(a, f.first);
  f.touch(f.first, 'work.txt');
  f.advance(29);
  f.maintain();
  assert.equal(store.getItem(f.board, a).item_status, 'claimed', 'under 30 idle minutes the pinned claim stays');
  f.advance(1);
  f.maintain();
  const lapsed = store.getItem(f.board, a);
  assert.equal(lapsed.item_status, 'open', 'thirty idle minutes return the pinned item to the queue');
  assert.equal(lapsed.item_owner, null);
  f.claim(a, f.second);
  assert.equal(store.getItem(f.board, a).item_owner, f.second, 'another seat takes the lapsed item');
});

test('lib.lapse-claim.an-unpinned-claim-idle-for-30: an unpinned claim idle for 30 minutes keeps its seat until 40 [C7]', t => {
  const f = fixture(t);
  const a = f.add();
  f.claim(a, f.first);
  f.touch(f.first, 'work.txt');
  f.advance(30);
  f.maintain();
  assert.equal(store.getItem(f.board, a).item_status, 'claimed', 'only pinned items use the shorter interval');
  f.advance(10);
  f.maintain();
  assert.equal(store.getItem(f.board, a).item_status, 'open');
});
