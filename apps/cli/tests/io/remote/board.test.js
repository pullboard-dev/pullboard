/** A seat with board.url set reads show and whoami from a served board and opens no board.sqlite [P7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpBox } from '../../fixtures/api.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { runCliInProcess } from '../../fixtures/process.js';

/** A served board, an agent on it, and a boardless clone on its own machine home that points at the board by URL. */
async function remoteSeat(t) {
  const box = await apiHttpBox(t);
  const linked = join(box.dir, 'agent');
  runFixtureGit(['worktree', 'add', '-q', '--detach', linked], { cwd: box.root, env: box.env, stdio: 'pipe' });
  const agent = box.cli(linked, 'join', 'app').agent;
  const item = box.cli(box.root, 'add', 'app', 'Remote readable item', '--specs', 'G1', '--criterion', 'Read it by URL').item.item_id;
  const clone = join(box.dir, 'studio');
  runFixtureGit(['clone', '-q', box.root, clone], { cwd: box.dir, env: box.env, stdio: 'pipe' });
  const machine = join(box.dir, 'studio-home');
  mkdirSync(machine);
  const env = { ...box.env, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_AGENT: agent };
  /** Run the real CLI dispatch in the clone, awaited, so the in-process server keeps answering. */
  const run = (...args) => runCliInProcess(args, { cwd: clone, env });
  return { box, agent, item, clone, env, run };
}

/** The board files a local board command would create or open in the clone. */
function cloneBoard(clone) {
  return existsSync(join(clone, '.git', 'pullboard', 'board.sqlite'));
}

test('show <id> prints a served item from a clone with no board.sqlite [P7]', { timeout: 60_000 }, // budget: hang ceiling for fixture init, a served board and four CLI calls, not a throughput claim.
async (t) => {
  const seat = await remoteSeat(t);
  assert.equal((await seat.run('settings', 'board.url', seat.box.origin)).status, 0);
  assert.equal((await seat.run('settings', 'board.token', '--', seat.box.key)).status, 0);
  const shown = await seat.run('show', String(seat.item), '--json');
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  const document = JSON.parse(shown.stdout);
  assert.equal(document.item.id, seat.item);
  assert.equal(document.item.title, 'Remote readable item');
  const text = await seat.run('show', String(seat.item));
  assert.match(text.stdout, new RegExp(`^#${seat.item}  \\S+  app  Remote readable item`, 'mu'));
  assert.match(text.stdout, /criterion: Read it by URL/u);
  assert.equal(cloneBoard(seat.clone), false, 'show opened no local board');
});

test("whoami prints the named agent's lane from the served board with no board.sqlite [P7]", { timeout: 60_000 }, // budget: hang ceiling for fixture init, a served board and three CLI calls, not a throughput claim.
async (t) => {
  const seat = await remoteSeat(t);
  assert.equal((await seat.run('settings', 'board.url', `${seat.box.origin}${seat.box.path}`)).status, 0);
  assert.equal((await seat.run('settings', 'board.token', '--', seat.box.key)).status, 0);
  const me = await seat.run('whoami', '--json');
  assert.equal(me.status, 0, me.stdout + me.stderr);
  const document = JSON.parse(me.stdout);
  assert.equal(document.id, seat.env.PULLBOARD_AGENT);
  assert.equal(document.lane, 'app');
  const text = await seat.run('whoami');
  assert.match(text.stdout, new RegExp(`^${seat.env.PULLBOARD_AGENT} \\(app lane\\) via ${seat.box.origin.replace(/[.]/gu, '\\.')}`, 'u'));
  assert.equal(cloneBoard(seat.clone), false, 'whoami opened no local board');
});

test('an unreachable board.url or a wrong token refuses with a code and a next step [P7]', { timeout: 60_000 }, // budget: hang ceiling for fixture init, a served board and five CLI calls, not a throughput claim.
async (t) => {
  const seat = await remoteSeat(t);
  await seat.run('settings', 'board.url', seat.box.origin);
  await seat.run('settings', 'board.token', '--', 'not-the-serve-key');
  const wrong = await seat.run('show', String(seat.item));
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /^pullboard: \[BOARD_TOKEN\] .*\nnext: .+/mu);
  await seat.run('settings', 'board.url', 'http://127.0.0.1:9');
  const away = await seat.run('whoami');
  assert.equal(away.status, 1);
  assert.match(away.stderr, /^pullboard: \[BOARD_UNREACHABLE\] .*\nnext: .+/mu);
  assert.equal(cloneBoard(seat.clone), false, 'a refused read opened no local board');
});
