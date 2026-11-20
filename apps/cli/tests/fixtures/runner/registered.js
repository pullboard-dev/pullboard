/**
 * A fixture box with the ssh stand-in registered as its runner, set up so a runner-only submit settles in bounded time [C7,V4].
 * Why: under pull dispatch a submit offers its gate as a job row and returns at once; with a runner registered the CLI starts
 * no local runner and the fixture's settle starts none either, so the row sat queued until the 180 s file kill (#10303).
 * The stand-in runs on this host, so its load reading is the real runner's load, and load-aware dispatch held the item's
 * add --wait baseline 25-100 s on a busy runner; the item is added before the runner is registered and that wait is off.
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOST } from '../../../../../packages/gate/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../../packages/gate/tests/fixtures/runner/ssh.js';
import { startFixtureLocalRunner } from './local-start.js';
import { fixtureRunnerFolder } from './local-start.js';
import { CLI_ENTRY } from './entry.js';

// Budget: how long the fixture board API has to print its address before the fixture gives up.
const API_MS = 30_000;

/**
 * Install the ssh stand-in in the box's PATH, turn load-aware dispatch off and run `add` (an item and its main baseline)
 * before `runner add`, so the baseline is measured at once and not queued behind the stand-in's real host load; then turn the
 * board host's local runner off and stop it, so the registered runner alone takes the pulled jobs.
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
  // The add may have started the board host's local runner; the registered runner must be the one that serves the queue.
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const previous = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  writeFileSync(settingsFile, JSON.stringify({ ...previous, gate: { ...previous.gate, localRunner: false } }));
  const stopped = box.run(box.repo, 'runner', 'local', '--off');
  if (stopped.code !== 0) throw new Error(`runner local --off failed: ${stopped.err}`);
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
 * Run `pullboard runner serve` as the registered runner against the box's board API, which `pullboard serve` runs on
 * loopback with a session key of its own, as the local runner's API does; the runner is named for the stand-in's host and
 * keeps its cache in the stand-in's home, so a pulled gate job runs under the registered runner's home and the settled
 * job's logRunner names the host, not the board host's local runner [C7,V4,#10318].
 * Why the real board API: it applies a gate's receipt to the item, which a settle waits for.
 * Why the box machine home: the serve process keeps the machine's registered runner and gate.runnersOnly, as the local
 * runner did. Both processes write to the fixture runner log, so a settle waiting on that folder wakes on every line.
 *
 * @param {import('node:test').TestContext} t - Stops both processes when the test ends.
 * @param {object} box - The e2e project (dir, repo, env).
 * @param {{ paths: Record<string, string> }} stand - The folders registerStandInAfterAdd returned.
 * @returns {Promise<{ pid: number, url: string, name: string, folder: string }>} The runner's pid, the board url it pulls from, its id and its cache folder.
 */
export async function serveRegisteredRunner(t, box, { paths }) {
  const logFolder = fixtureRunnerFolder(box.env);
  mkdirSync(logFolder, { recursive: true, mode: 0o700 });
  const log = join(logFolder, 'runner.log');
  const kept = ['PULLBOARD_MACHINE_HOME', 'PULLBOARD_ACCOUNT_HOME', 'PULLBOARD_HOME'];
  const env = { ...box.env };
  for (const key of Object.keys(env)) if (key.startsWith('PULLBOARD_') && !kept.includes(key)) delete env[key];
  const api = spawn(process.execPath, [CLI_ENTRY, 'serve', '--port', '0', '--json'], { cwd: box.repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { api.kill('SIGTERM'); } catch { /* already gone */ } });
  // A line that arrives after the box is removed has nowhere to go; the runner is stopping then.
  const note = chunk => { try { appendFileSync(log, chunk); } catch { /* the fixture folder is gone */ } };
  let out = '';
  api.stderr.on('data', note);
  const board = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`the fixture board API did not print its address within ${API_MS} ms:\n${out.slice(-2000)}`)), API_MS);
    api.once('exit', code => { clearTimeout(timer); fail(new Error(`the fixture board API exited ${code} before it printed its address:\n${out.slice(-2000)}`)); });
    api.stdout.on('data', chunk => {
      out += chunk;
      try { const document = JSON.parse(out); clearTimeout(timer); done(document); } catch { /* the document is not complete yet */ }
    });
  });
  const listing = new URL(board.url);
  const key = listing.searchParams.get('k');
  const boards = await (await fetch(listing)).json();
  const id = (boards.boards ?? boards)[0]?.id;
  if (!key || !id) throw new Error(`the fixture board API named no board to pull from: ${JSON.stringify(boards).slice(0, 2000)}`);
  const url = `${listing.origin}/api/v1/boards/${id}`;
  const folder = join(paths.remoteHome, 'pull-runner');
  const runner = spawn(process.execPath, [CLI_ENTRY, 'runner', 'serve', url, '--as', HOST, '--key', key, '--directory', folder], { cwd: paths.remoteHome, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { runner.kill('SIGTERM'); } catch { /* already gone */ } });
  runner.stdout.on('data', note);
  runner.stderr.on('data', note);
  return { pid: runner.pid, url, name: HOST, folder };
}
