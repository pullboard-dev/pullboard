/**
 * Shared parts of the pipeline hop harnesses [C7]: the source tree under test, scratch folders, hop results and the
 * process-leak check every harness runs in its after-hook.
 *
 * Why a kit: each harness runs real git, a real SQLite board and real child processes in its own temp folders, and
 * on 8 Nov a test dispatcher outlived its test and relaunched real gates into a deleted home (#3850). One leak check,
 * shared, means no harness can forget it.
 */
/** @pullboard-module-loads apps/cli/src/io/landing/budget.js apps/cli/tests/fixtures/child.js apps/cli/tests/fixtures/e2e.js apps/cli/tests/fixtures/gate/execution.js apps/cli/tests/fixtures/runner/ssh.js apps/cli/tests/fixtures/testkit.js packages/drive/index.js packages/gate/index.js packages/gate/src/io/shards/proof.js packages/jobs/index.js */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { after } from 'node:test';
import { pathToFileURL } from 'node:url';

/** Every folder this harness made or was handed, so the leak check and the cleanup cover them all. */
const folders = new Set();

/** Git's environment for scratch repositories: no machine or account config, a fixed identity. */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Hop Harness',
  GIT_AUTHOR_EMAIL: 'hops@example.test', GIT_COMMITTER_NAME: 'Hop Harness', GIT_COMMITTER_EMAIL: 'hops@example.test' };

/**
 * Run git in a scratch repository and return its trimmed stdout, failing on a non-zero exit.
 *
 * @param {string} dir
 * @param {...string} args
 * @returns {string}
 */
export function gitIn(dir, ...args) {
  const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${run.stderr}`);
  return run.stdout.trim();
}

/**
 * Copy a commit's tree of a Pullboard checkout into `into` as a fresh one-commit repository, never its working tree
 * and never its history. Why: the stale-tooling repro moves a tool root's HEAD, and `--against` runs harnesses on an
 * older tree; neither may touch the checkout itself.
 *
 * @param {string} root - The checkout to copy from.
 * @param {string} into - An empty scratch folder.
 * @param {string} [commit]
 * @returns {string} `into`.
 */
export function committedCopy(root, into, commit = 'HEAD') {
  mkdirSync(into, { recursive: true });
  const archive = `${into}.tar`;
  gitIn(root, 'archive', '--format=tar', '-o', archive, commit);
  const run = spawnSync('tar', ['-xf', archive, '-C', into], { encoding: 'utf8' });
  rmSync(archive, { force: true });
  if (run.status !== 0) throw new Error(`copy of ${commit} failed: ${run.stderr}`);
  gitIn(into, 'init', '-q', '-b', 'main');
  gitIn(into, 'add', '-A');
  gitIn(into, 'commit', '-q', '-m', `copy of ${commit}`);
  return into;
}

/** The checkout these harness files live in. */
const CHECKOUT = resolve(import.meta.dirname, '../../../../..');

/**
 * Extract an older commit of the checkout into a scratch folder this harness watches and removes.
 *
 * @param {string} commit
 * @returns {Promise<string>} The older tree's folder.
 */
async function olderTree(commit) {
  const { privateFixtureFiles } = await import(pathToFileURL(join(CHECKOUT, 'apps/cli/tests/fixtures/child.js')).href);
  const dir = privateFixtureFiles('pullboard-hop-against-').root;
  folders.add(dir);
  return committedCopy(CHECKOUT, join(dir, 'pullboard'), commit);
}

/**
 * The source tree the harness exercises: this checkout, the tree named by PULLBOARD_HOP_ROOT, or the commit named by
 * PULLBOARD_HOP_AGAINST extracted into a scratch folder.
 * Why the override: a repro must fail on the old behaviour, so `packages/gate/src/io/matrix.js --against <commit>` runs the same
 * harness against an older tree.
 */
export const ROOT = process.env.PULLBOARD_HOP_ROOT ? resolve(process.env.PULLBOARD_HOP_ROOT)
  : process.env.PULLBOARD_HOP_AGAINST ? await olderTree(process.env.PULLBOARD_HOP_AGAINST) : CHECKOUT;

/**
 * Import one module of the tree under test by its repo-relative path.
 *
 * @param {string} path - Repo-relative module path, such as `packages/drive/index.js`.
 * @returns {Promise<any>}
 */
export function from(path) {
  return import(pathToFileURL(join(ROOT, path)).href);
}

/**
 * Make a private scratch folder in the system temp folder, named `pullboard-hop-<name>-…`, and watch it.
 *
 * @param {string} name - The harness's short name.
 * @returns {Promise<string>} The folder's real path.
 */
export async function scratch(name) {
  const { privateFixtureFiles } = await from('apps/cli/tests/fixtures/child.js');
  const dir = privateFixtureFiles(`pullboard-hop-${name}-`).root;
  folders.add(dir);
  return dir;
}

/**
 * Watch a folder something else made (an e2e sandbox), so its processes count as this harness's children.
 *
 * @param {string} dir
 * @returns {string} The same folder.
 */
export function track(dir) {
  folders.add(dir);
  return dir;
}

/**
 * The live processes whose command line or environment names one of the folders, excluding this process and `ps`.
 * Why `ps -E`: a detached dispatcher or gate driver names its sandbox only in its environment (its machine home).
 *
 * @param {Iterable<string>} dirs
 * @returns {{ pid: number, command: string }[]}
 */
export function survivors(dirs) {
  const names = [...dirs].flatMap(dir => [dir, dir.replace(/^\/private\//u, '/')]);
  if (!names.length) return [];
  const listing = spawnSync('ps', ['-E', '-ww', '-ax', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listing.status !== 0) throw new Error(`ps failed: ${listing.stderr}`);
  const found = [];
  for (const line of listing.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || pid === listing.pid || !names.some(name => match[2].includes(name))) continue;
    found.push({ pid, command: match[2].slice(0, 600) });
  }
  return found;
}

/**
 * Wait up to `graceMs` for every process naming the folders to exit on its own, then kill what is left.
 *
 * @param {Iterable<string>} dirs
 * @param {number} graceMs
 * @returns {Promise<{ pid: number, command: string }[]>} The processes that outlived the grace and were killed.
 */
export async function settleProcesses(dirs, graceMs) {
  let left = survivors(dirs);
  if (left.length) {
    try { await waitUntil(() => { left = survivors(dirs); return !left.length; }, 'every process exits', graceMs, 200); }
    catch (error) { if (!left.length) throw error; }
  }
  for (const { pid } of left) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return left;
}

/**
 * Register the after-hook every harness needs: wait for its processes, kill and report any that outlive the grace,
 * then remove its folders. The hook fails the harness when a child leaked.
 *
 * @param {{ graceMs?: number, before?: () => Promise<void> | void }} [options] - `before` runs first, to release
 *   anything the harness still holds (a held gate).
 */
export function guardProcesses({ graceMs = 30_000, before } = {}) {
  after(async () => {
    try { await before?.(); }
    finally {
      const leaked = await settleProcesses(folders, graceMs);
      for (const dir of folders) rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
      assert.deepEqual(leaked, [], `no process this harness started outlives it by ${graceMs} ms`);
    }
  });
}

/**
 * Record one hop's measured result on stdout: a line for people, and a `# hop-row` JSON line packages/gate/src/io/matrix.js reads.
 *
 * @param {string} hop - The hop row id, as harnesses/pipeline/hops.js names it.
 * @param {{ pass: boolean, ms?: number | null, measured: string, cause?: string }} result
 */
export function report(hop, { pass, ms = null, measured, cause = '' }) {
  const row = { hop, status: pass ? 'PASS' : 'FAIL', ms, measured, cause };
  process.stdout.write(`# hop-row ${JSON.stringify(row)}\n`);
  process.stdout.write(`# hop ${hop} ${row.status} ${ms === null ? '' : `${Math.round(ms)} ms `}${measured}${cause ? ` (${cause})` : ''}\n`);
}

/**
 * Run a check, record its hop result either way, and rethrow a failure so node:test reports it.
 *
 * @param {string} hop
 * @param {() => Promise<{ ms?: number | null, measured: string }>} check - Returns what it measured; throws on a
 *   broken invariant.
 */
export async function hopCheck(hop, check) {
  const started = performance.now();
  try {
    const result = await check();
    report(hop, { pass: true, ...result });
  } catch (error) {
    report(hop, { pass: false, ms: error?.hop?.ms ?? performance.now() - started, measured: error?.hop?.measured ?? 'invariant broken',
      cause: String(error?.message ?? error).split('\n')[0].slice(0, 240) });
    throw error;
  }
}

/**
 * Assert a measured hop invariant; a failure carries the measurement, so the matrix shows the number that broke it.
 *
 * @param {boolean} ok
 * @param {string} message - What the invariant says, and what was seen.
 * @param {{ ms?: number | null, measured: string }} measurement
 */
export function within(ok, message, measurement) {
  if (!ok) throw Object.assign(new assert.AssertionError({ message, actual: false, expected: true, operator: '==' }), { hop: measurement });
}

/**
 * Poll until `predicate` returns a truthy value, or fail after `timeoutMs`.
 *
 * @template T
 * @param {() => T | Promise<T>} predicate
 * @param {string} what - Named in the failure.
 * @param {number} timeoutMs
 * @param {number} [everyMs]
 * @returns {Promise<T>}
 */
export function waitUntil(predicate, what, timeoutMs, everyMs = 100) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolveWait, rejectWait) => {
    /** Look once; settle on a value, an error or the deadline, else look again after `everyMs`. */
    const look = async () => {
      let value;
      try { value = await predicate(); } catch (error) { rejectWait(error); return; }
      if (value) resolveWait(value);
      else if (Date.now() >= until) rejectWait(new Error(`${what}: not seen within ${timeoutMs} ms`));
      else setTimeout(look, everyMs);
    };
    look();
  });
}

/**
 * Whether a process is gone; any other signal error leaves it presumed alive.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
