/**
 * A fixture box with the ssh stand-in registered as its runner, set up so a runner-only submit settles in bounded time [C7,V4].
 * Why: under pull dispatch a submit offers its gate as a job row and returns at once; with a runner registered the CLI starts
 * no local runner and the fixture's settle starts none either, so the row sat queued until the 180 s file kill (#10303).
 * The stand-in runs on this host, so its load reading is the real runner's load, and load-aware dispatch held the item's
 * add --wait baseline 25-100 s on a busy runner; the item is added before the runner is registered and that wait is off.
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HOST } from '../../../../../packages/gate/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../../packages/gate/tests/fixtures/runner/ssh.js';
import { startFixtureLocalRunner } from './local-start.js';
import { fixtureRunnerFolder } from './local-start.js';
import { pullQueue } from '../pull.js';
import { CLI_ENTRY } from './entry.js';

/**
 * Install the ssh stand-in in the box's PATH, turn load-aware dispatch off and run `add` (an item and its main baseline)
 * before `runner add`, so the baseline is measured at once and not queued behind the stand-in's real host load.
 *
 * @param {object} box - The e2e project (dir, repo, env, run).
 * @param {{ requests: string, add: () => object | Promise<object> }} options - The stand-in's request log, and the add to run before registering.
 * @returns {Promise<{ paths: Record<string, string>, root: string, added: object }>} The stand-in folders, its runner root, and add's result.
 */
export async function registerStandInAfterAdd(box, { requests, add }) {
  const paths = Object.fromEntries(['bin', 'worker', 'remoteHome', 'remoteMachine'].map(name => [name, join(box.dir, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths.remoteHome, machineHome: paths.remoteMachine, requests });
  box.env.PATH = `${paths.bin}:${box.env.PATH}`;
  const off = box.run(box.repo, 'settings', 'gate.loadAwareDispatch', 'off');
  if (off.code !== 0) throw new Error(`settings gate.loadAwareDispatch off failed: ${off.err}`);
  const added = await add();
  const registered = box.run(box.repo, 'runner', 'add', HOST, '--slots', '1', '--browser', '1');
  if (registered.code !== 0) throw new Error(`runner add ${HOST} failed: ${registered.err}`);
  return { paths, root: join(paths.remoteHome, '.pullboard-runner'), added };
}

/**
 * Make sure the board host's local runner serves the box's job queue, so a pulled gate job is taken even with a runner
 * registered; a gate switch the test set in box.env reaches it.
 *
 * @param {object} box - The e2e project.
 * @returns {{ pid: number, started: boolean }}
 */
export function serveBoardQueue(box) {
  return startFixtureLocalRunner(box.env, box.repo, { entry: CLI_ENTRY });
}

/**
 * Run `pullboard runner serve` as the registered runner: the board's job queue on loopback, and a serve process named
 * for the stand-in's host with its cache in the stand-in's home, so a pulled gate job runs under the registered runner's
 * home (its check executes in the stand-in worker, profile.executionRunner naming the host) and not under the board
 * host's local runner [C7,V4,#10318].
 * Why the box machine home: the serve process keeps the machine's registered runner and gate.runnersOnly, as the local
 * runner did. Its output goes to the fixture runner log, so a settle waiting on that folder wakes on every line it writes.
 *
 * @param {import('node:test').TestContext} t - Stops the runner when the test ends.
 * @param {object} box - The e2e project (dir, repo, env).
 * @param {{ paths: Record<string, string> }} stand - The folders registerStandInAfterAdd returned.
 * @returns {Promise<{ pid: number, url: string, name: string, folder: string }>} The runner's pid, the board url it pulls from, its id and its cache folder.
 */
export async function serveRegisteredRunner(t, box, { paths }) {
  const queue = await pullQueue(t, { ...box, boardFile: join(box.repo, '.git', 'pullboard', 'board.sqlite') });
  const log = join(fixtureRunnerFolder(box.env), 'runner.log');
  mkdirSync(fixtureRunnerFolder(box.env), { recursive: true, mode: 0o700 });
  const folder = join(paths.remoteHome, 'pull-runner');
  const env = { ...box.env };
  for (const key of Object.keys(env)) if (key.startsWith('PULLBOARD_') && !['PULLBOARD_MACHINE_HOME', 'PULLBOARD_ACCOUNT_HOME', 'PULLBOARD_HOME'].includes(key)) delete env[key];
  const child = spawn(process.execPath, [CLI_ENTRY, 'runner', 'serve', queue.url, '--as', HOST, '--directory', folder], { cwd: paths.remoteHome, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const note = chunk => appendFileSync(log, chunk);
  child.stdout.on('data', note);
  child.stderr.on('data', note);
  t.after(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } });
  return { pid: child.pid, url: queue.url, name: HOST, folder };
}
