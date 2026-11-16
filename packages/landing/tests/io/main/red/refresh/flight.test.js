/** @pullboard-test-input packages/landing/src/io/main/red/refresh.js */
/**
 * One background main-red refresh per machine, started at most once per spacing window, holding no checkout lease [C7].
 * On 9 Nov detached refreshes piled up under launchd, two per landing, while writes queued behind them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { privateFixtureFiles } from '../../../../../../gate/tests/fixtures/child.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimRefreshStart } from '../../../../../src/io/main/red/refresh/flight.js';
import { holdRefreshFlight } from '../../../../../src/io/main/red/refresh/flight.js';
import { refreshFlightFiles } from '../../../../../src/io/main/red/refresh/flight.js';
import { runningRefresh } from '../../../../../src/io/main/red/refresh/flight.js';
import { refreshEnvironment } from '../../../../../src/io/step/publish.js';
import { spawnDetachedRefresh } from '../../../../../src/io/step/publish.js';

const BIN = fileURLToPath(new URL('../../../../../src/io/main/red/refresh.js', import.meta.url));
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** A private folder removed when the test ends. */
function folder(t) {
  const dir = privateFixtureFiles('pullboard-refresh-flight-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The pid of a process that has already exited. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

test('a refresh starts only when none runs and none started within the spacing window [C7]', (t) => {
  const files = refreshFlightFiles(folder(t));
  assert.equal(claimRefreshStart(files), true, 'the first start is free');
  assert.equal(claimRefreshStart(files), false, 'a second start within the window is refused');
  const old = (Date.now() - 6 * 60_000) / 1000;
  utimesSync(files.stamp, old, old);
  assert.equal(claimRefreshStart(files), true, 'a start after the window is free again');
  utimesSync(files.stamp, old, old);
  const letGo = holdRefreshFlight(files);
  assert.ok(letGo, 'this process takes the refresh lock');
  assert.equal(claimRefreshStart(files), false, 'no start while a live refresh holds the lock');
  letGo();
  assert.equal(existsSync(files.lock), false, 'letting go removes the lock');
});

test('one refresh lock per machine: a live holder keeps it, a dead or replaced holder loses it [C7]', (t) => {
  const files = refreshFlightFiles(folder(t));
  const first = holdRefreshFlight(files);
  assert.ok(first);
  assert.equal(holdRefreshFlight(files), null, 'a second refresh while the first runs gets nothing');
  first();
  writeFileSync(files.lock, JSON.stringify({ pid: deadPid(), at: Date.now() }));
  assert.equal(runningRefresh(files), null, 'a lock whose process exited names no running refresh');
  const second = holdRefreshFlight(files);
  assert.ok(second, 'a dead holder\'s lock is taken over');
  second();
  writeFileSync(files.lock, JSON.stringify({ pid: process.pid, at: Date.now() - 31 * 60_000 }));
  assert.equal(runningRefresh(files), null, 'a lock past its lifetime names no running refresh, even when its pid is alive again');
});

test('a second refresh process exits at once, and a launch is skipped while one runs [C7]', (t) => {
  const dir = folder(t);
  const home = join(dir, 'machine-home');
  const files = refreshFlightFiles(home);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const letGo = holdRefreshFlight(files);
  t.after(() => letGo?.());
  const root = join(dir, 'repo');
  const run = spawnSync(process.execPath, ['--no-warnings', BIN, root, SHA_A, SHA_B], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PULLBOARD_MACHINE_HOME: home } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(join(root, '.git', 'pullboard', 'automatic-landing', 'main-red-refresh.log'), 'utf8'), /skipped: another refresh is running/u);
  assert.equal(spawnDetachedRefresh(root, SHA_A, SHA_B), false, 'no child starts while a refresh runs');
});

test('a refresh runs without a checkout lease token or agent session id [C7]', () => {
  const env = refreshEnvironment({ PATH: '/usr/bin', PULLBOARD_CHECKOUT_SESSION_TOKEN: 'token', CLAUDE_CODE_SESSION_ID: 'session', CODEX_SESSION_ID: 'codex', CODEX_THREAD_ID: 'thread' });
  assert.deepEqual(env, { PATH: '/usr/bin' });
});
