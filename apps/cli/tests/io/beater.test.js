/** The claim beater beats a URL-joined seat through the board host's heartbeat move [P7,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../fixtures/child.js';
import { policyRepository } from '../../../../packages/store/tests/fixtures/submit.js';
import { main } from '../../src/io/entry.js';
import { wipRef } from '../../src/io/item/wip.js';
import { agentSession } from '../../src/io/beater.js';
import { processTable } from '../../src/io/beater.js';
import { runBeater } from '../../src/io/beater.js';
import { startClaimBeater } from '../../src/io/beater.js';

test('cli.io-beater.remote-binding-beats-until-refused: runBeater with a remote binding beats through an injected sender every injected everyMs and stops after the first refusal [P7,B3,C7]', async () => {
  const remote = { url: 'http://127.0.0.1:1/api/v1/boards/b1', token: 'k', agent: 'core-1' };
  const answers = [true, true, false];
  const sent = [];
  const waits = [];
  const result = await runBeater(
    { cwd: process.cwd(), seat: 'core-1', board: '/nowhere/board.sqlite', lock: '/nowhere/beaters/core-1', agent: { pid: 1, start: null }, everyMs: 7, remote },
    { alive: () => true, send: async (binding) => { sent.push(binding); return answers.shift(); }, wait: async (ms) => { waits.push(ms); } },
  );
  assert.equal(sent.length, 3, 'it beat until the third answer refused, then no more');
  assert.ok(sent.every((binding) => binding === remote), 'every beat carried the remote binding');
  assert.deepEqual(waits, [7, 7, 7], 'each pause was the injected everyMs');
  assert.equal(result.beats, 3);
});

test('cli.io-beater.worker-not-ancestor: clause 1: PULLBOARD_AGENT_PID wins, and a second seat under an ancestor another live beater watches is recorded as shared [B4,C7]', async () => {
  const named = agentSession({ env: { get: (name) => (name === 'PULLBOARD_AGENT_PID' ? '4242' : undefined) }, table: new Map([[4242, { ppid: 1, start: 'Thu Nov 20 01:19:00 2026', comm: 'claude' }]]) });
  assert.deepEqual(named, { pid: 4242, start: 'Thu Nov 20 01:19:00 2026', named: true }, 'the named worker wins over any ancestor');
  const root = privateFixtureFiles('beater-shared-').root;
  const board = join(root, 'board.sqlite');
  const ancestor = { pid: 900, start: 'Thu Nov 20 01:19:00 2026' };
  const env = { get: () => undefined, all: () => ({}) };
  const launched = [];
  const launch = (entry, { args }) => { launched.push(JSON.parse(args[0])); return 5000 + launched.length; };
  const first = await startClaimBeater(root, { seat: 'core-1', board }, { env, session: () => ancestor, launch, alive: () => true });
  const second = await startClaimBeater(root, { seat: 'core-2', board }, { env, session: () => ancestor, launch, alive: () => true });
  assert.equal(first.shared, false, 'the first seat under the ancestor is not shared');
  assert.equal(second.shared, true, 'the second seat under the same ancestor is recorded as shared');
  assert.equal(launched[1].shared, true, 'the launched beater is told it is shared, so the quiet rule governs it');
  const locks = readdirLocks(join(root, 'beaters'));
  assert.deepEqual(locks.map((lock) => lock.shared).sort(), [false, true], 'two live beaters whose locks do not both depend only on the ancestor');
});

const SESSION_START = 'Thu Nov 20 01:19:00 2026';
/** One fake ps row; sess is the session id, 0 where ps reports none (macOS prints 0 for every process). */
const row = (ppid, comm, sess = 0) => ({ ppid, sess, start: SESSION_START, comm });
const noEnv = { get: () => undefined };

test('cli.io-beater.subreaper-is-never-the-agent: clause 1: agentSession returns null when the walk reaches the process that adopted an orphaned shell, whatever its name [B3,C7]', () => {
  for (const adopter of ['systemd', 'tini', 'containerd-shim', 'dumb-init', 'launchd-helper']) {
    // The dead agent 850 led the session the orphans still carry; the adopter leads its own.
    const orphanedShell = new Map([[1, row(0, 'init', 1)], [900, row(1, adopter, 900)], [901, row(900, 'bash', 850)], [902, row(901, 'node', 850)]]);
    assert.equal(agentSession({ env: noEnv, pid: 902, ppid: 901, table: orphanedShell }), null, `${adopter} adopted the shell and is not the agent`);
    const orphanedCli = new Map([[1, row(0, 'init', 1)], [900, row(1, adopter, 900)], [902, row(900, 'node', 850)]]);
    assert.equal(agentSession({ env: noEnv, pid: 902, ppid: 900, table: orphanedCli }), null, `${adopter} adopted the CLI itself`);
    const deeper = new Map([[1, row(0, 'init', 1)], [700, row(1, 'systemd', 700)], [900, row(700, adopter, 900)], [901, row(900, 'bash', 851)], [902, row(901, 'node', 851)]]);
    assert.equal(agentSession({ env: noEnv, pid: 902, ppid: 901, table: deeper }), null, `${adopter} below pid 1 adopted the shell and is not the agent`);
  }
  const toInit = new Map([[1, row(0, 'init')], [901, row(1, 'bash')]]);
  assert.equal(agentSession({ env: noEnv, ppid: 901, table: toInit }), null, 'shells up to pid 1 still return null');
});

test('cli.io-beater.named-and-real-agent-still-bind: clause 2: PULLBOARD_AGENT_PID still names the agent session and a real agent behind its shells still binds [B3,C7]', () => {
  const table = new Map([[1, row(0, 'init')], [800, row(1, 'terminal')], [850, row(800, 'claude')], [851, row(850, 'zsh')], [852, row(851, 'bash')]]);
  assert.deepEqual(agentSession({ env: noEnv, ppid: 852, table }), { pid: 850, start: SESSION_START }, 'the agent behind its shells binds');
  const linux = new Map([[1, row(0, 'init', 1)], [700, row(1, 'systemd', 700)], [800, row(700, 'gnome-terminal-', 700)], [810, row(800, 'bash', 810)],
    [850, row(810, 'claude', 810)], [851, row(850, 'bash', 851)], [852, row(851, 'bash', 851)], [853, row(852, 'node', 851)]]);
  assert.deepEqual(agentSession({ env: noEnv, pid: 853, ppid: 852, table: linux }), { pid: 850, start: SESSION_START }, 'a forked Linux tree whose session leaders are all on the chain binds');
  const named = agentSession({ env: { get: (name) => (name === 'PULLBOARD_AGENT_PID' ? '900' : undefined) }, ppid: 852, table: new Map([...table, [900, row(1, 'systemd')]]) });
  assert.deepEqual(named, { pid: 900, start: SESSION_START, named: true }, 'the named pid wins even when init is its parent');
});

test('cli.io-beater.launchd-child-host-binds: clause 2: a real agent host whose parent is launchd or init binds, on macOS and on Linux [B3,C7]', () => {
  for (const host of ['Terminal', 'iTerm2', 'Claude', 'Electron']) {
    const mac = new Map([[1, row(0, 'launchd')], [600, row(1, `/Applications/${host}.app/Contents/MacOS/${host}`)], [601, row(600, '-zsh')], [602, row(601, 'node')]]);
    assert.deepEqual(agentSession({ env: noEnv, pid: 602, ppid: 601, table: mac }), { pid: 600, start: SESSION_START }, `${host} under launchd binds`);
    const direct = new Map([[1, row(0, 'launchd')], [600, row(1, host)], [602, row(600, 'node')]]);
    assert.deepEqual(agentSession({ env: noEnv, pid: 602, ppid: 600, table: direct }), { pid: 600, start: SESSION_START }, `${host} under launchd running the CLI with no shell binds`);
  }
  const container = new Map([[1, row(0, 'tini', 1)], [40, row(1, 'claude', 1)], [41, row(40, 'bash', 41)], [42, row(41, 'node', 41)]]);
  assert.deepEqual(agentSession({ env: noEnv, pid: 42, ppid: 41, table: container }), { pid: 40, start: SESSION_START }, 'an agent whose parent is pid 1 binds when no link was adopted');
  const real = processTable();
  assert.equal(real?.get(process.pid)?.ppid, process.ppid, `this ${process.platform} machine's ps rows parse with the session column`);
  assert.ok(Number.isSafeInteger(real.get(process.pid).sess), 'the session id reads as a number (0 on macOS)');
});

function readdirLocks(dir) {
  return readdirSyncNames(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
}
function readdirSyncNames(dir) { return readdirSync(dir); }

test('cli.io-beater.quiet-seat-stops: clause 2: a beater stops and drops its lock once its seat is quiet for the stale interval, and a recent event or file change keeps its beats [B4,C7]', async () => {
  const root = privateFixtureFiles('beater-quiet-').root;
  const MIN = 60_000;
  const run = async ({ event, file }) => {
    const lock = join(root, 'lock-' + Math.random().toString(16).slice(2));
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    let clock = 0;
    const beats = [];
    const result = await runBeater(
      { cwd: root, seat: 'core-1', board: '/nowhere/board.sqlite', lock, agent: { pid: 1, start: null }, everyMs: 10 * MIN, quietMs: 30 * MIN },
      { alive: () => true, now: () => clock, lastEvent: async () => event(clock), lastFileChange: () => file(clock),
        seatOf: () => ({ seat: 'core-1', file: '/nowhere/board.sqlite' }), held: async () => true, beat: async () => { beats.push(clock); },
        wait: async (ms) => { clock += ms; } },
    );
    return { result, beats, lockLeft: existsSync(lock) };
  };
  const quiet = await run({ event: () => null, file: () => null });
  assert.deepEqual(quiet.beats, [0, 10 * MIN, 20 * MIN], 'it beat until the quiet interval ran out, then stopped though the watched pid lives');
  assert.equal(quiet.lockLeft, false, 'it dropped its lock');
  const eventful = await run({ event: (clock) => (clock >= 40 * MIN ? null : clock), file: () => null });
  assert.ok(eventful.beats.length > 5, 'a recent board event keeps the beats going');
  const filed = await run({ event: () => null, file: (clock) => (clock >= 50 * MIN ? null : clock) });
  assert.ok(filed.beats.length > 6, 'a recent file change in the item folder keeps the beats going');
});

/** An item folder with one commit and one uncommitted file, and a git runner for it. */
function claimedFolder(t) {
  const root = privateFixtureFiles('beater-wip-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'item-folder');
  mkdirSync(folder);
  policyRepository(folder);
  const git = (...args) => runFixtureGit(args, { cwd: folder });
  writeFileSync(join(folder, 'tracked.txt'), 'one\n');
  git('add', 'tracked.txt');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=F', '-c', 'user.email=f@example.test', 'commit', '-q', '-m', 'tracked');
  writeFileSync(join(folder, 'work.txt'), 'uncommitted work\n');
  return { folder, git };
}

test('cli.io-beater.tick-snapshots-claimed-folder: clause 1: one claim beater tick for a seat holding a claimed item calls snapshotWip, and refs/pullboard/wip/<item> then holds the uncommitted change [C7,#12568]', async (t) => {
  const { folder, git } = claimedFolder(t);
  let held = true;
  await runBeater(
    { cwd: folder, seat: 'core-1', board: '/nowhere/board.sqlite', lock: join(folder, 'no-lock'), agent: { pid: 1, start: null }, everyMs: 10 },
    { alive: () => true, now: () => 1_000_000, lastEvent: async () => null, lastFileChange: () => null,
      seatOf: () => ({ seat: 'core-1', file: '/nowhere/board.sqlite' }), held: async () => { const was = held; held = false; return was; }, beat: async () => {}, wait: async () => {},
      wip: { claimed: async () => [{ item: 12597, folder }], now: () => 1_000_000 } },
  );
  assert.equal(String(git('show', `${wipRef(12597)}:work.txt`)).trim(), 'uncommitted work', 'the tick left the uncommitted change on the wip ref');
  held = true;
  const failing = await runBeater(
    { cwd: folder, seat: 'core-1', board: '/nowhere/board.sqlite', lock: join(folder, 'no-lock'), agent: { pid: 1, start: null }, everyMs: 10 },
    { alive: () => true, now: () => 2_000_000, lastEvent: async () => null, lastFileChange: () => null,
      seatOf: () => ({ seat: 'core-1', file: '/nowhere/board.sqlite' }), held: async () => { const was = held; held = false; return was; }, beat: async () => {}, wait: async () => {},
      wip: { claimed: async () => { throw new Error('board unreadable'); }, snapshot: () => { throw new Error('snapshot failed'); } } },
  );
  assert.equal(failing.beats, 1, 'a failing snapshot never fails the tick');
});

test('cli.io-beater.board-call-snapshots-claimed-folder: clause 2: a board call the claiming seat makes through entry.js snapshots its claimed item folder at most once a minute per item, and a seat with no claim snapshots nothing [C7,#12568]', async (t) => {
  const { folder, git } = claimedFolder(t);
  let clock = 5_000_000;
  const snapshots = [];
  const wip = { seatOf: () => ({ seat: 'core-1', board: '/nowhere/board.sqlite' }), now: () => clock,
    claimed: async () => [{ item: 12597, folder }], snapshot: (path, item) => snapshots.push([path, item]) };
  const streams = { cwd: folder, stdout: { write() {} }, stderr: { write() {} }, wip };
  await main(['--version'], streams);
  assert.deepEqual(snapshots, [[folder, 12597]], 'the first board call snapshotted the claimed folder');
  clock += 30_000;
  await main(['--version'], streams);
  assert.equal(snapshots.length, 1, 'a second call inside the minute snapshotted nothing');
  clock += 31_000;
  await main(['--version'], streams);
  assert.equal(snapshots.length, 2, 'a call a minute later snapshotted again');
  const bare = [];
  await main(['--version'], { ...streams, wip: { ...wip, claimed: async () => [], snapshot: (...args) => bare.push(args) } });
  assert.deepEqual(bare, [], 'a seat with no claim snapshots nothing');
  assert.equal(git('rev-parse', '--verify', '-q', 'HEAD').length > 0, true, 'the folder is a real repository');
});

test('cli.io-beater.board-call-cost-measured: measurement: a board call adds under 20 ms when no snapshot is due, and the real snapshot cost is printed [C7,#12568]', async (t) => {
  const { folder } = claimedFolder(t);
  const { snapshotOnBoardCall } = await import('../../src/io/beater.js');
  const wip = { seatOf: () => ({ seat: 'core-1', board: '/nowhere/board.sqlite' }), now: () => 9_000_000, claimed: async () => [{ item: 12597, folder }] };
  const real = process.hrtime.bigint();
  await snapshotOnBoardCall(folder, wip);
  const snapshotMs = Number(process.hrtime.bigint() - real) / 1e6;
  const idle = process.hrtime.bigint();
  await snapshotOnBoardCall(folder, wip);
  const idleMs = Number(process.hrtime.bigint() - idle) / 1e6;
  console.log(`BOARD-CALL-COST no-snapshot-due ${idleMs.toFixed(1)} ms; real-snapshot ${snapshotMs.toFixed(1)} ms`);
  assert.ok(idleMs < 20, `no snapshot due added ${idleMs.toFixed(1)} ms`);
  // The real snapshot cost is printed, not asserted: #12746 owns taking it off the command path.
});
