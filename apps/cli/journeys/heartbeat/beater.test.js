/** A claim starts a detached beater bound to the agent session; long commands keep a 60 s keepalive [B3,C7,#5726]. */
import assert from 'node:assert/strict';
import {
  test,
  after,
} from 'node:test';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { watch } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { agentSession } from '../../src/io/beater.js';
import { startClaimBeater } from '../../src/io/beater.js';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../tests/fixtures/e2e.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const BEATER = new URL('../../src/io/beater.js', import.meta.url).href;

/** Resolve once `check` holds, re-reading it on each change in `dir`; fail after ten seconds without it. */
async function whenTrue(dir, check, what) {
  if (check()) return;
  try { for await (const _ of watch(dir, { signal: AbortSignal.timeout(10_000) })) if (check()) return; }
  catch (error) { if (error.name !== 'AbortError') throw error; }
  assert.ok(check(), `timed out waiting for ${what}`);
}

/** Whether a process id still answers. */
function running(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

/** Block until `pid` has exited, by a shell loop bounded at ten seconds; true when it did. */
function exited(pid) {
  spawnSync('/bin/sh', ['-c', `while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.05; done`], { timeout: 10_000 });
  return !running(pid);
}

/** A long-lived stand-in for an agent session (Claude, Codex or any tool): it only sleeps until killed. */
function fakeAgent(t) {
  const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { agent.kill('SIGKILL'); } catch { /* already gone */ } });
  return agent;
}

/** A joined seat holding one claim, made by the real CLI on a real Git repository and SQLite board. */
function claimedSeat(env = {}) {
  const box = helpers.project('true');
  Object.assign(box.env, env);
  const joined = joinFixtureSeat(box, box.web, 'web', { model: FIXTURE_MODEL });
  assert.equal(joined.code, 0, `${joined.out}\n${joined.err}`);
  const seat = JSON.parse(joined.out).agent;
  const id = String(fileFixtureItem(box, box.repo, { lane: 'web', title: 'Kept alive', check: 'true', args: ['--specs', 'G1'] }).item_id);
  const claimed = box.run(box.web, 'claim', id);
  assert.equal(claimed.code, 0, `${claimed.out}\n${claimed.err}`);
  const pullboard = join(box.repo, '.git', 'pullboard');
  return { box, seat, id, lock: join(pullboard, 'beaters', `${encodeURIComponent(seat)}.json`), presence: join(pullboard, 'board.sqlite.presence.sqlite') };
}

/** Move the seat's recorded heartbeat ten minutes back, so the next real beat is visible; returns that old time. */
function ageHeartbeat(presence, seat) {
  const old = new Date(Date.now() - 600_000).toISOString();
  const db = new DatabaseSync(presence);
  try {
    db.exec('PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS heartbeat(seat TEXT PRIMARY KEY, at TEXT NOT NULL)');
    const changed = db.prepare('UPDATE heartbeat SET at=? WHERE seat LIKE ?').run(old, `%"${seat}"]`).changes;
    assert.equal(changed, 1, 'the seat has one recorded heartbeat to age');
  } finally { db.close(); }
  return old;
}

/** The seat's recorded heartbeat time. */
function heartbeatAt(presence, seat) {
  const db = new DatabaseSync(presence, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout=2000'); return db.prepare('SELECT at FROM heartbeat WHERE seat LIKE ?').get(`%"${seat}"]`)?.at ?? null; }
  finally { db.close(); }
}

test('clause 1: the agent session is the nearest ancestor that is not the shell or a wrapper the CLI ran in, for any agent tool [B3]', t => {
  const agent = fakeAgent(t);
  // The agent opens a shell for one command, the way Claude's Bash tool and Codex both do; `; true` keeps the shell from exec'ing away.
  const probe = `import(${JSON.stringify(BEATER)}).then(m => process.stdout.write(JSON.stringify(m.agentSession({ env: {} }))))`;
  // The probe is a plain node child with a bare environment, not a test child, so it prints its own stdout.
  const shell = spawnSync('/bin/sh', ['-c', `env "${process.execPath}" -e '${probe}'; true`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(shell.status, 0, shell.stderr);
  assert.notEqual(shell.stdout, '', `the probe printed its session: ${shell.stderr}`);
  // The probe's own parent chain: sh (shell) -> this test process. The test process stands in for the agent here.
  assert.equal(JSON.parse(shell.stdout).pid, process.pid, 'the shell and env are skipped; the first other ancestor is the session');
  const table = new Map([[40, { ppid: 30, start: 'x', comm: '-zsh' }], [30, { ppid: 20, start: 'y', comm: '/usr/bin/timeout' }],
    [20, { ppid: 1, start: 'Wed Nov 11 14:43:32 2026', comm: '/opt/codex/bin/codex' }]]);
  assert.deepEqual(agentSession({ env: {}, ppid: 40, table }), { pid: 20, start: 'Wed Nov 11 14:43:32 2026' });
  assert.equal(agentSession({ env: {}, ppid: 40, table: new Map([[40, { ppid: 1, start: 'x', comm: 'bash' }]]) }), null, 'only shells up to launchd: no session, so no beater');
  assert.deepEqual(agentSession({ env: { PULLBOARD_AGENT_PID: String(agent.pid) }, ppid: 40, table: new Map([[agent.pid, { ppid: 1, start: 's', comm: 'x' }]]) }), { pid: agent.pid, start: 's' });
  assert.equal(startClaimBeater('/any', { seat: 'core-1', board: '/r/.git/pullboard/board.sqlite' }, { env: {}, session: () => null }).started, false);
});

test('clause 1: a claim starts a detached beater that beats while the agent lives and stops when the agent exits [B3,C7]', async t => {
  const agent = fakeAgent(t);
  const f = claimedSeat({ PULLBOARD_CLAIM_BEATER: '1', PULLBOARD_AGENT_PID: String(agent.pid), PULLBOARD_BEATER_MS: '100' });
  assert.equal(existsSync(f.lock), true, 'the claim recorded its beater');
  const beater = JSON.parse(readFileSync(f.lock, 'utf8'));
  t.after(() => { try { process.kill(beater.pid, 'SIGKILL'); } catch { /* already gone */ } });
  assert.equal(beater.agent.pid, agent.pid, 'bound to the agent session, not the CLI shell parent');
  assert.equal(running(beater.pid), true, 'the beater outlives the claim command');
  // No CLI command runs from here on: only the beater can refresh the heartbeat.
  const old = ageHeartbeat(f.presence, f.seat);
  await whenTrue(dirname(f.presence), () => heartbeatAt(f.presence, f.seat) > old, 'a beat with no CLI command running');
  // Killed and not yet reaped by this test: a zombie agent must read as gone too.
  agent.kill('SIGKILL');
  // With the agent dead nothing beats again, so the two-minute seat-gone release takes the claim.
  assert.equal(exited(beater.pid), true, 'the beater stops once its agent died');
  assert.equal(existsSync(f.lock), false, 'the beater drops its own lock');
});

test('clause 1: the beater stops when the claim ends or the worktree is gone [B3,C7]', async t => {
  const agent = fakeAgent(t);
  const env = { PULLBOARD_CLAIM_BEATER: '1', PULLBOARD_AGENT_PID: String(agent.pid), PULLBOARD_BEATER_MS: '100' };
  const released = claimedSeat(env);
  const first = JSON.parse(readFileSync(released.lock, 'utf8')).pid;
  t.after(() => { try { process.kill(first, 'SIGKILL'); } catch { /* already gone */ } });
  const done = released.box.run(released.box.web, 'release', released.id, '--reason', 'BLOCKED', '--note', 'fixture beater done');
  assert.equal(done.code, 0, `${done.out}\n${done.err}`);
  assert.equal(exited(first), true, 'the beater stops once the claim ended');
  const removed = claimedSeat(env);
  const second = JSON.parse(readFileSync(removed.lock, 'utf8')).pid;
  t.after(() => { try { process.kill(second, 'SIGKILL'); } catch { /* already gone */ } });
  rmSync(removed.box.web, { recursive: true, force: true });
  assert.equal(exited(second), true, 'the beater stops once the worktree is gone');
  assert.equal(running(agent.pid), true, 'the agent still lives: the claim or the worktree ended each beat');
});

test('clause 2: a long read command from a seat keeps the 60 s keepalive submit has [B3,C7]', async () => {
  const f = claimedSeat({ PULLBOARD_KEEPALIVE_MS: '100' });
  const released = f.box.run(f.box.web, 'release', f.id, '--reason', 'BLOCKED', '--note', 'free the seat so next waits');
  assert.equal(released.code, 0, `${released.out}\n${released.err}`);
  const old = ageHeartbeat(f.presence, f.seat);
  // next --wait with no work for the seat blocks about 3 s and writes no move; only the keepalive can beat.
  const waited = f.box.run(f.box.web, 'next', '--wait', '0.05', '--lane', 'web');
  assert.ok(heartbeatAt(f.presence, f.seat) > old, `the waiting command beat its seat\n${waited.out}\n${waited.err}`);
});
