/** The screen job: merge a sprint item's commit onto its base without a checkout, run the static checks and the trusted re-check, and record one receipt [V16,M1]. */
import { spawn } from 'node:child_process';
import { fileSystemAdapter } from '../../../fs/index.js';
const disk = fileSystemAdapter();
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import { finishJob } from '../../../jobs/index.js';
import { scratchBase } from '../../../kernel/light.js';
import { environmentAdapter } from '../../../env/index.js';
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
function runChild(command, args, { cwd, env = environmentAdapter().all(), shell = false }) {
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
  const env = { ...environmentAdapter().all(), GIT_TERMINAL_PROMPT: '0' };
  for (const name of HOOK_GIT_ENV) delete env[name];
  return runChild('git', args, { cwd, env });
}

/** The repo-relative files the item's commit changes against the base, the files the static checks read. */
async function changedFiles(repo, base, commit) {
  const listed = await runGit(repo, ['diff', '--name-only', `${base}...${commit}`]);
  return listed.status === 0 ? listed.stdout.split('\n').filter(Boolean) : [];
}

/**
 * The gate's static checks over the merged tree, written out to a scratch folder through a private index, told which
 * files changed. No configured command is green, as at the gate.
 * Why a private index: the screening checkout's own index and folders stay untouched, and no worktree is made.
 *
 * @param {string} repo
 * @param {string} tree - The merged tree id.
 * @param {string | null | undefined} command - The board's `staticChecks` setting, captured when the screen was queued.
 * @param {string[]} files
 * @returns {Promise<{ status: 'green' | 'red' | 'skipped', problem?: string }>}
 */
async function runStatic(repo, tree, command, files) {
  if (!command?.trim()) return { status: 'skipped' };
  const scratch = await disk.promises.mkdtemp(join(scratchBase(), 'pullboard-screen-'));
  try {
    const env = { ...environmentAdapter().all(), GIT_INDEX_FILE: join(scratch, 'index') };
    for (const name of HOOK_GIT_ENV.filter(name => name !== 'GIT_INDEX_FILE')) delete env[name];
    const read = await runChild('git', ['read-tree', tree], { cwd: repo, env });
    const out = read.status === 0 ? await runChild('git', ['checkout-index', '--all', `--prefix=${join(scratch, 'tree')}/`], { cwd: repo, env }) : read;
    if (out.status !== 0) return { status: 'red', problem: `the merged tree could not be written out: ${out.stderr.split('\n')[0]}` };
    const ran = await runChild(command, [], { cwd: join(scratch, 'tree'), shell: true, env: { ...environmentAdapter().all(), PULLBOARD_CHANGED_FILES: files.join('\n') } });
    if (ran.status === 0) return { status: 'green' };
    const last = `${ran.stdout}\n${ran.stderr}`.trim().split('\n').filter(Boolean).at(-1) ?? `exit ${ran.status}`;
    return { status: 'red', problem: last.slice(0, 300) };
  } finally {
    await disk.promises.rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Screen one commit on a base: merge it with `git merge-tree` (no checkout, no worktree), then run the static checks
 * and the trusted re-check over base..commit. A conflict stops the screen there and names the files.
 *
 * @param {string} repo - A checkout the trusted caller owns, holding both commits.
 * @param {{ commit: string, base: string, staticCommand?: string | null }} at
 * @param {{ recheck: (repo: string, base: string, head: string) => { commit: string, kind: 'secret' | 'header', problem: string }[] }} ports
 *   recheck: the trusted range re-check (recheckRange from the commits cell), passed in so this cell keeps its edges.
 * @returns {Promise<{ conflicts: string[] | null, staticRun: { status: string, problem?: string } | null, rechecked: object[] | null }>}
 */
export async function screenCommit(repo, { commit, base, staticCommand = null }, { recheck }) {
  const merged = await runGit(repo, ['merge-tree', '--write-tree', '--name-only', base, commit]);
  const [tree, ...rest] = merged.stdout.split('\n');
  // With --name-only a conflict prints the tree, the conflicted paths, a blank line, then git's messages.
  const named = rest.indexOf('') < 0 ? rest : rest.slice(0, rest.indexOf(''));
  if (merged.status === 1) return { conflicts: named.filter(Boolean), staticRun: null, rechecked: null };
  if (merged.status !== 0 || !tree) throw new Refused('SCREEN_MERGE_UNREADABLE', `cannot merge ${commit} onto ${base}: ${merged.stderr}`, 'fetch both commits into the screening checkout, then screen again');
  const staticRun = await runStatic(repo, tree, staticCommand, await changedFiles(repo, base, commit));
  return { conflicts: null, staticRun, rechecked: recheck(repo, base, commit) };
}

/**
 * Run a sprint item's screen as a keyed job and record its receipt as the job's result: the stored receipt when any
 * driver already screened this commit, digest and base, else screened here under the job's lease.
 * Items at any other pace are never screened, so steady boards never see a screen job. Once the receipt is stored the job
 * ends at done with no lease, as a finished landing does.
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
  const ran = await keyedResult(db, { kind: SCREEN_KIND, key: screenKey(at), owner, now, runs,
    produce: async () => screenReceipt({ item: item.id, ...at, ...await screenCommit(repo, { ...at, staticCommand }, { recheck }), leased: true }) });
  // A stored receipt ends the job at done and frees its lease, so open-job counts and lease sweeps stop seeing it [#12196].
  if (ran.state !== 'pending') finishJob(runs?.db ?? db, ran.job, owner, { now: now() });
  return ran;
}
