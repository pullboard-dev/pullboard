/** The claim beater beats a URL-joined seat through the board host's heartbeat move [P7,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { agentSession } from '../../src/io/beater.js';
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
