/** Item-folder commands heartbeat their seat, and long commands keep it fresh until they end [C7,#2960]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { openBoard } from '../../../lib/src/logic/native.js';
import { captureLapsedClaims } from '../../../../packages/health/index.js';
import { heartbeatCommand } from '../../index.js';
import { stopSeatKeepalive } from '../../src/io/presence.js';
import { seatKeepalive } from '../../src/io/presence.js';
import { itemFolderPath } from '../../index.js';

/** Run Git in a fixture repository without inheriting a hook's GIT_* variables. */
function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A clock the test moves by hand, so minutes pass without waiting for them. */
function manualClock(start = Date.parse('2026-11-04T12:00:00.000Z')) {
  let now = start;
  return { now: () => new Date(now), advance: ms => { now += ms; } };
}

/** A real repo and SQLite board: one core seat holding a claim, with that claim's item folder opened. */
function fixture(t, start, { adopted = false } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-seat-heartbeat-')));
  const repo = join(directory, 'seat');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root');
  const clock = manualClock(start);
  const file = join(directory, 'board.sqlite');
  // @pullboard-board-file persistence: the heartbeat command and a child process reopen this exact board file.
  const board = openBoard(file, clock);
  t.after(() => { stopSeatKeepalive(); store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  store.register(board, { lane: 'coordinator', path: join(directory, 'main') });
  // An adopted fixture registers the claim's seat at a second checkout, so the item folder below belongs to an earlier seat's name.
  const holder = adopted ? join(directory, 'second-seat') : repo;
  if (adopted) git(repo, 'worktree', 'add', '-q', '--detach', holder, 'main');
  const seat = store.register(board, { lane: 'core', path: holder, route: 'mid' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'long submit', criterion: 'prove', specIds: ['C7'], route: 'mid', check: 'true', brief: 'Files: src/a.js\nTest: proves it' });
  store.claim(board, id, { agentId: seat, lane: 'core', leaseMs: 7_200_000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'digest:bar' }) });
  const folder = itemFolderPath(repo, id);
  git(repo, 'worktree', 'add', '-q', '-b', `core/item-${id}`, folder, 'main');
  return { board, clock, file, seat, id, folder, repo };
}

/** The seat's recorded heartbeat, read the way presence and seat-gone read it. */
function heartbeatAt(f) {
  return store.withSeatPresence(f.board, [store.agentById(f.board, f.seat)])[0].heartbeatAt;
}

test('[C7,#2960] a command run from a seat\'s item folder records that seat\'s heartbeat, like its checkout', t => {
  stopSeatKeepalive();
  const f = fixture(t);
  f.clock.advance(90_000);
  assert.notEqual(heartbeatAt(f), f.clock.now().toISOString(), 'the claim\'s heartbeat is stale before the command');
  const lines = [];
  heartbeatCommand({ err: line => lines.push(line) }, { ctx: { info: { root: f.folder }, clock: f.clock }, board: f.board });
  assert.equal(heartbeatAt(f), f.clock.now().toISOString(), `item-folder command heartbeats the seat: ${lines.join(' | ')}`);
  f.clock.advance(90_000);
  heartbeatCommand({ err: () => {} }, { ctx: { info: { root: f.repo }, clock: f.clock }, board: f.board });
  assert.equal(heartbeatAt(f), f.clock.now().toISOString(), 'the seat checkout heartbeats the same seat');
});

test('[C7,#2960] while a long command runs its seat keeps a fresh heartbeat and seat-gone never reclaims the claim', t => {
  stopSeatKeepalive();
  const f = fixture(t);
  const started = f.clock.now().getTime();
  heartbeatCommand({ err: () => {} }, { ctx: { info: { root: f.folder }, file: f.file, clock: f.clock }, board: f.board });
  const running = seatKeepalive();
  assert.ok(running && running.everyMs <= 60_000, 'a running command keeps a heartbeat at least once a minute');
  // Five simulated minutes of a running submit, one keepalive beat a minute: well past the two-minute seat-gone limit.
  for (let minute = 1; minute <= 5; minute += 1) {
    f.clock.advance(60_000);
    running.beat();
    assert.equal(heartbeatAt(f), f.clock.now().toISOString(), `minute ${minute}: the running command refreshed its seat`);
  }
  f.clock.advance(59_000);
  assert.ok(f.clock.now().getTime() - started >= 5 * 60_000);
  assert.ok(f.clock.now().getTime() - Date.parse(heartbeatAt(f)) < 2 * 60_000, 'quiet less than the seat-gone limit');
  const snapshot = captureLapsedClaims({ info: { root: f.repo }, config: {}, clock: f.clock }, f.board, 'coordinator');
  const gone = (snapshot?.claims ?? []).filter(row => row.idle === 'seat-gone');
  assert.deepEqual(gone, [], 'seat-gone takes no claim from a seat whose command is still running');
});

test('[C7,#2960] the keepalive heartbeat never keeps a finished command\'s process alive', t => {
  stopSeatKeepalive();
  const f = fixture(t);
  const script = `
    const { openBoard } = await import(${JSON.stringify(new URL('../../../lib/src/logic/native.js', import.meta.url).href)});
    const store = await import(${JSON.stringify(new URL('../../../../packages/store/index.js', import.meta.url).href)});
    const { heartbeatCommand } = await import(${JSON.stringify(new URL('../../src/io/presence.js', import.meta.url).href)});
    const board = openBoard(${JSON.stringify(f.file)});
    const ctx = { info: { root: ${JSON.stringify(f.folder)} }, file: ${JSON.stringify(f.file)}, clock: { now: () => new Date() } };
    heartbeatCommand({ err: () => {} }, { ctx, board, keepaliveMs: 50 });
    store.closeBoard(board);`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.signal, null, 'the process exited on its own instead of hanging on the keepalive timer');
  assert.equal(run.status, 0, run.stderr);
});

/**
 * A claim that moved to a second seat while its work stayed in the first seat's item folder (an adopted folder).
 * The clock runs an hour ahead of the files Git just wrote, so only a file the test touches reads as recent work.
 */
function adoptedFolderFixture(t, workAgoMs) {
  stopSeatKeepalive();
  const f = fixture(t, Date.now() + 3_600_000, { adopted: true });
  const edited = join(f.folder, 'edited.txt');
  writeFileSync(edited, 'work\n');
  const at = new Date(f.clock.now().getTime() - workAgoMs);
  utimesSync(edited, at, at);
  utimesSync(join(f.folder, '.git'), at, at);
  f.clock.advance(3 * 60_000);
  return { f, id: f.id };
}

test('clause 1: a claim whose item folder was adopted from an earlier seat is not released while its work is recent [C7]', t => {
  const { f, id } = adoptedFolderFixture(t, 5 * 60_000);
  const snapshot = captureLapsedClaims({ info: { root: f.repo }, config: {}, clock: f.clock }, f.board, 'coordinator');
  assert.deepEqual((snapshot?.claims ?? []).filter(row => row.idle === 'seat-gone' && row.id === id), [], 'the sentinel finds the adopted folder and sees its recent edit');
});

test('clause 2: a claim whose seat is quiet and whose adopted folder is idle is still released as seat-gone [C7]', t => {
  const { f, id } = adoptedFolderFixture(t, 40 * 60_000);
  const snapshot = captureLapsedClaims({ info: { root: f.repo }, config: {}, clock: f.clock }, f.board, 'coordinator');
  assert.deepEqual((snapshot?.claims ?? []).filter(row => row.idle === 'seat-gone' && row.id === id).map(row => row.id), [id]);
});
