/** The screen job: merge a sprint item's commit onto its base in a scratch tree, run the static checks and the trusted re-check, and record one receipt [V16,M1]. */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import { keyedResult } from './keyed.js';
import { SCREEN_KIND } from '../logic/screen.js';
import { screenKey } from '../logic/screen.js';
import { screenQueued } from '../logic/screen.js';
import { screenReceipt } from '../logic/screen.js';

/** Git environment names a calling hook may set; a scratch tree's git must never read them. */
const HOOK_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];

/**
 * Run a child without blocking, so the keyed job's lease timer keeps firing; resolve its status and trimmed text, never throwing.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, shell?: boolean }} options
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
function runChild(command, args, { cwd, env = process.env, shell = false }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // Budget: the last 64 KiB of each stream is kept; a finding needs only the last line.
    child.stdout.setEncoding('utf8').on('data', part => { stdout = (stdout + part).slice(-65_536); });
    child.stderr.setEncoding('utf8').on('data', part => { stderr = (stderr + part).slice(-65_536); });
    child.once('error', error => resolve({ status: 1, stdout: stdout.trim(), stderr: error.message }));
    child.once('close', status => resolve({ status: status ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

/** Run git in `cwd` without the caller's hook environment. */
function runGit(cwd, args) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of HOOK_GIT_ENV) delete env[name];
  return runChild('git', args, { cwd, env });
}

/** The repo-relative files the item's commit changes against the base, the files the static checks read. */
async function changedFiles(repo, base, commit) {
  const listed = await runGit(repo, ['diff', '--name-only', `${base}...${commit}`]);
  return listed.status === 0 ? listed.stdout.split('\n').filter(Boolean) : [];
}

/**
 * The gate's static checks in the merged scratch tree, told which files changed. No configured command is green, as at the gate.
 *
 * @param {string} tree
 * @param {string | null | undefined} command - The board's `staticChecks` setting, captured when the screen was queued.
 * @param {string[]} files
 * @returns {Promise<{ status: 'green' | 'red' | 'skipped', problem?: string }>}
 */
async function runStatic(tree, command, files) {
  if (!command?.trim()) return { status: 'skipped' };
  const ran = await runChild(command, [], { cwd: tree, shell: true, env: { ...process.env, PULLBOARD_CHANGED_FILES: files.join('\n') } });
  if (ran.status === 0) return { status: 'green' };
  const last = `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim().split('\n').filter(Boolean).at(-1) ?? `exit ${ran.status}`;
  return { status: 'red', problem: last.slice(0, 300) };
}

/**
 * Screen one commit on a base: merge it in a scratch worktree, then run the static checks and the trusted re-check
 * over base..commit. A conflict stops the screen there and names the files. The scratch tree is removed whatever happens.
 *
 * @param {string} repo - A checkout the trusted caller owns, holding both commits.
 * @param {{ commit: string, base: string, staticCommand?: string | null }} at
 * @param {{ recheck: (repo: string, base: string, head: string) => { commit: string, kind: 'secret' | 'header', problem: string }[] }} ports
 *   recheck: the trusted range re-check (recheckRange from the commits cell), passed in so this cell keeps its edges.
 * @returns {Promise<{ conflicts: string[] | null, staticRun: { status: string, problem?: string } | null, rechecked: object[] | null }>}
 */
export async function screenCommit(repo, { commit, base, staticCommand = null }, { recheck }) {
  const scratch = await mkdtemp(join(tmpdir(), 'pullboard-screen-'));
  const tree = join(scratch, 'tree');
  try {
    const added = await runGit(repo, ['worktree', 'add', '--detach', '--quiet', tree, base]);
    if (added.status !== 0) throw new Refused('SCREEN_BASE_UNREADABLE', `cannot open ${base} in a scratch tree: ${added.stderr}`, 'fetch the base into the screening checkout, then screen again');
    const merged = await runGit(tree, ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Pullboard screen', '-c', 'user.email=screen@pullboard.invalid', 'merge', '--no-ff', '--no-edit', '--quiet', commit]);
    if (merged.status !== 0) {
      const unmerged = await runGit(tree, ['diff', '--name-only', '--diff-filter=U']);
      const conflicts = unmerged.status === 0 ? unmerged.stdout.split('\n').filter(Boolean) : [];
      return { conflicts, staticRun: null, rechecked: null };
    }
    const staticRun = await runStatic(tree, staticCommand, await changedFiles(repo, base, commit));
    return { conflicts: null, staticRun, rechecked: recheck(repo, base, commit) };
  } finally {
    await runGit(repo, ['worktree', 'remove', '--force', tree]);
    await rm(scratch, { recursive: true, force: true });
    await runGit(repo, ['worktree', 'prune']);
  }
}

/**
 * Run a sprint item's screen as a keyed job and record its receipt as the job's result: the stored receipt when any
 * driver already screened this commit, digest and base, else screened here under the job's lease.
 * Items at any other pace are never screened, so steady boards never see a screen job.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle.
 * @param {{ repo: string, item: { id: number, pace?: string | null, commit: string, digest?: string | null }, base: string, owner: string,
 *   staticCommand?: string | null, recheck: Function, now?: () => number, runs?: { db: import('node:sqlite').DatabaseSync } | null }} options
 * @returns {Promise<{ state: 'skipped' } | { state: 'stored' | 'produced' | 'pending', job: string, result?: ReturnType<typeof screenReceipt> }>}
 */
export async function runScreenJob(db, { repo, item, base, owner, staticCommand = null, recheck, now = Date.now, runs = null }) {
  if (!screenQueued(item)) return { state: 'skipped' };
  if (typeof recheck !== 'function') throw new Refused('SCREEN_RECHECK_MISSING', 'A screen needs the trusted range re-check.', 'pass { recheck: recheckRange } from the commits cell');
  const at = { commit: item.commit, digest: item.digest ?? null, base };
  return keyedResult(db, { kind: SCREEN_KIND, key: screenKey(at), owner, now, runs,
    produce: async () => screenReceipt({ item: item.id, ...at, ...await screenCommit(repo, { ...at, staticCommand }, { recheck }), leased: true }) });
}
