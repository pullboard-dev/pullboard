/** The resident board starts through the reachable launcher, as the lander does [C7,#5760]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { RESIDENT_ENTRY } from '../../../src/io/resident/client.js';
import { claimResidentStart } from '../../../src/io/resident/client.js';
import { residentSocket } from '../../../src/io/resident/client.js';
import { residentStartFile } from '../../../src/io/resident/client.js';
import { runResident } from '../../../src/io/resident/client.js';
import { startResident } from '../../../src/io/resident/client.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const place = { socket: '/tmp/x.sock', pid: '/tmp/x.pid', home: '/nonexistent-home' };

test('cli.io-resident-start.the-resident-board-starts-through-the-launcher: clause 1: the resident board starts through the launcher that runs a launchd job and falls back to a detached spawn [C7]', async () => {
  const calls = [];
  await startResident(place, '/entry.js', 'v1', { A: 'b' }, async (command, args, options) => { calls.push({ command, args, options }); return { pid: 1, launchd: true }; });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [RESIDENT_ENTRY, place.socket, '/entry.js', 'v1', place.pid]);
  assert.equal(calls[0].options.cwd, process.cwd(), 'a missing home keeps the working folder');
  assert.deepEqual(calls[0].options.env, { A: 'b' });
});

test('cli.io-resident-start.a-launcher-that-throws-never-fails-the: clause 1: a launcher that throws never fails the command in hand [C7]', async () => {
  await startResident(place, '/entry.js', 'v1', {}, () => { throw new Error('no launchd'); });
});

/** A scratch board with no resident process, and a scratch entry outside any checkout so codeVersion needs no Git. */
function scratchBoard(t) {
  const root = privateFixtureFiles('pullboard-resident-start-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const board = join(root, 'b');
  mkdirSync(join(board, '.git', 'pullboard'), { recursive: true });
  writeFileSync(join(board, '.git', 'pullboard', 'board.sqlite'), '');
  const entry = join(root, 'code', 'apps', 'cli', 'pullboard.js');
  mkdirSync(join(root, 'code', 'apps', 'cli'), { recursive: true });
  writeFileSync(entry, '');
  writeFileSync(join(root, 'code', 'package.json'), '{}');
  return { board, entry, env: { PULLBOARD_RESIDENT: '1', PULLBOARD_RESIDENT_POOL: '1' } };
}

/** Run one `show` through the client with a counting starter; resolves to the in-process hand-back (null). */
function showThrough({ board, entry, env }, starts) {
  const sink = { write() {}, isTTY: false };
  return runResident(['show', '1'], { entry, cwd: board, env, stdout: sink, stderr: sink, start: async (place) => { starts.push(place.pid); } });
}

test('cli.io-resident-start.concurrent-commands-on-one-slot-start-one-resident: clause 1: concurrent commands that find no resident on a slot start exactly one resident process there; the rest run in-process [C7]', async (t) => {
  const scratch = scratchBoard(t);
  const starts = [];
  const codes = await Promise.all(Array.from({ length: 8 }, () => showThrough(scratch, starts)));
  assert.deepEqual(codes, Array(8).fill(null), 'every command runs in-process while the resident loads');
  assert.equal(starts.length, 1, `one starter per slot, not ${starts.length}`);
  // While that start is pending, a later command still starts none.
  await showThrough(scratch, starts);
  assert.equal(starts.length, 1);
});

test('cli.io-resident-start.a-stale-start-lock-is-taken-over: clause 2: a start lock older than the stale age is taken over, so a starter that died before listening never blocks its slot [C7]', async (t) => {
  const scratch = scratchBoard(t);
  const pid = residentSocket(scratch.board, scratch.entry, 0).pid;
  writeFileSync(residentStartFile(pid), '');
  assert.equal(claimResidentStart(pid), false, 'a fresh lock holds the slot');
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(residentStartFile(pid), old, old);
  const starts = [];
  await showThrough(scratch, starts);
  assert.deepEqual(starts, [pid], 'the stale lock is taken over and the slot starts');
});
