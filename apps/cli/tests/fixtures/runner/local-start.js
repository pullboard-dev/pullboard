/**
 * The loopback local runner a fixture box runs its pulled gate and land jobs on, wherever the CLI itself starts none:
 * a relay-linked checkout, a served board's host, a box whose check-baseline runner used to be an SSH stand-in [P7,C7,#5821].
 * Why one module: controller dispatch, which ran a gate inside the submitting process, is going; every fixture that
 * submits or lands needs a runner under pull, and a gate switch the test sets in box.env must reach that runner.
 */
import { openSync } from 'node:fs';
import { closeSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { addLocalBoard } from '../../../../../packages/drive/index.js';
import { localRunnerState } from '../../../../../packages/drive/index.js';
import { stopFixtureLocalRunner } from './local-stop.js';

const BIN = resolve(import.meta.dirname, '../../../pullboard.js');
/** What a local runner keeps from its starting environment besides non-Pullboard variables (src/io/runner/local.js). */
const KEPT = new Set(['PULLBOARD_MACHINE_HOME', 'PULLBOARD_ACCOUNT_HOME', 'PULLBOARD_HOME', 'PULLBOARD_TEST_RUNNER_PID']);
// Budget: how long a just-spawned local runner has to write its first heartbeat before a start counts as failed.
const START_MS = 15_000;

/** The fixture machine's local runner folder. */
export function fixtureRunnerFolder(env) {
  return join(env.PULLBOARD_MACHINE_HOME, 'local-runner');
}

/** Whether a change to this environment key reaches a local runner: it keeps every non-Pullboard variable and the KEPT ones. */
function reachesRunner(key) {
  return typeof key === 'string' && (!key.startsWith('PULLBOARD_') || KEPT.has(key));
}

/**
 * Make sure the fixture machine's local runner serves the board at `root`, starting `pullboard runner local` there with
 * `env` as it is now when none is alive. Synchronous, so a fixture's synchronous setup or settle can call it.
 *
 * @param {Record<string, string | undefined>} env - The fixture environment; PULLBOARD_MACHINE_HOME names the machine.
 * @param {string} root - The board host's checkout.
 * @returns {{ pid: number, started: boolean }}
 */
export function startFixtureLocalRunner(env, root) {
  const folder = fixtureRunnerFolder(env);
  addLocalBoard(folder, root);
  const live = localRunnerState(folder);
  if (live) return { pid: live.pid, started: false };
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const kept = Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && reachesRunner(key)));
  delete kept.NODE_TEST_CONTEXT;
  const log = openSync(join(folder, 'runner.log'), 'a');
  try {
    const child = spawn(process.execPath, [BIN, 'runner', 'local'], { cwd: resolve(root), env: kept, detached: true, stdio: ['ignore', log, log] });
    child.unref();
  } finally { closeSync(log); }
  for (const until = Date.now() + START_MS; Date.now() < until;) {
    const state = localRunnerState(folder);
    if (state) return { pid: state.pid, started: true };
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error(`the fixture local runner for ${root} did not start within ${START_MS} ms; see ${join(folder, 'runner.log')}`);
}

/**
 * The fixture environment, where setting or deleting a variable the local runner keeps stops that runner, so the next
 * submit or landing (or startFixtureLocalRunner) starts it again with the new value.
 * Why: the local runner is long-lived and keeps the environment it started with, so a gate switch such as
 * LAND_SUPPRESS_RED set between two commands never reached a pulled gate (#7153).
 *
 * @param {Record<string, string | undefined>} env - The fixture environment object.
 * @returns {Record<string, string | undefined>} A proxy over the same object.
 */
export function runnerSwitchedEnv(env) {
  const restart = (target, key) => { if (reachesRunner(key) && target.PULLBOARD_MACHINE_HOME) stopFixtureLocalRunner(target.PULLBOARD_MACHINE_HOME); };
  return new Proxy(env, {
    set(target, key, value) {
      const changed = target[key] !== value;
      target[key] = value;
      if (changed) restart(target, key);
      return true;
    },
    deleteProperty(target, key) {
      const had = Object.hasOwn(target, key);
      delete target[key];
      if (had) restart(target, key);
      return true;
    },
  });
}

/**
 * Start the fixture machine's local runner for the board `cwd` belongs to when jobs wait and none is alive, unless the
 * machine turned the local runner off or registered runners of its own. Why: a gate switch (runnerSwitchedEnv) stops the
 * runner, and a command that offers a job without starting one (a verify, a test run) would otherwise leave it queued.
 *
 * @param {string} cwd - Where the fixture command ran.
 * @param {Record<string, string | undefined>} env - The fixture environment.
 * @returns {boolean} True when a runner was started.
 */
export function reviveFixtureLocalRunner(cwd, env) {
  if (!env.PULLBOARD_MACHINE_HOME || localRunnerState(fixtureRunnerFolder(env))) return false;
  let settings = {};
  try { settings = JSON.parse(readFileSync(join(env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8')); } catch { /* the defaults */ }
  if (settings.gate?.localRunner === false || (settings.runners ?? []).length) return false;
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, env, encoding: 'utf8' });
  const host = /^worktree (.+)$/mu.exec(listed.stdout ?? '')?.[1];
  return host ? startFixtureLocalRunner(env, host).started : false;
}

/**
 * Resolve with the first truthy value `probe` returns, read once now and again on every change to the fixture machine's
 * local runner folder (a log line per claim and receipt, a heartbeat every 5 s); refuses with the runner log after
 * deadlineMs. Why the runner's folder: a pulled job settles only when that runner acts, and a board read would wake itself.
 *
 * @template T
 * @param {Record<string, string | undefined>} env - The fixture environment.
 * @param {() => T | Promise<T>} probe - Reads the settled value, or a falsy one while the job is still open.
 * @param {{ deadlineMs: number, what: string }} options - The hang ceiling, and what is awaited, for the refusal.
 * @returns {Promise<T>}
 */
export function whenRunnerSettles(env, probe, { deadlineMs, what }) {
  const folder = fixtureRunnerFolder(env);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return new Promise((done, fail) => {
    let settled = false, reading = false, again = false, watcher = null;
    const stop = () => { settled = true; watcher?.close(); clearTimeout(timer); };
    const read = async () => {
      if (settled) return;
      if (reading) { again = true; return; }
      reading = true;
      let value;
      try { value = await probe(); } catch (error) { stop(); fail(error); return; } finally { reading = false; }
      if (value && !settled) { stop(); done(value); return; }
      if (again) { again = false; await read(); }
    };
    const timer = setTimeout(() => {
      stop();
      const log = join(folder, 'runner.log');
      fail(new Error(`${what} did not settle in ${deadlineMs} ms\nlocal runner log:\n${existsSync(log) ? readFileSync(log, 'utf8').slice(-3000) : '(no local runner log)'}`));
    }, deadlineMs);
    watcher = watch(folder, () => { read(); });
    read();
  });
}
