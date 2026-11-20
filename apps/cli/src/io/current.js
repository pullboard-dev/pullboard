/**
 * Agents run the board's current CLI: an entry started in a linked worktree whose HEAD is behind
 * the main checkout hands the command to the main checkout's entry [B17,B3,B34].
 * Worktrees fall hundreds of commits behind while their agents build, and landed fixes to the
 * CLI and its hooks must reach them at once, not at their next rebase.
 */
import { spawnSync } from 'node:child_process';
import { gitLocation } from './resident/client.js';
import { fileSystemAdapter } from '../../../../packages/fs/index.js';
import {
  basename,
  dirname,
  join,
  sep,
} from 'node:path';

const fs = fileSystemAdapter();

/** Run Git for this check only, never steered by a hook's GIT_DIR or GIT_INDEX_FILE. */
function git(cwd, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return spawnSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Resolve a path through symlinks, or null when it is gone. */
function real(path) {
  try { return fs.realpath(path); } catch { return null; }
}

/**
 * Decide whether this entry hands the command to the main checkout's entry: { target } to hand
 * over, { why } when it should but cannot, or null when this entry is the right code to run.
 * Silent cases: the opt-out, a cwd in another repository (as test fixtures use), and the main checkout
 * itself, whose .git is a directory, so the main entry never recurses. A cwd in another checkout of the
 * same repository (an item folder run with its seat's entry) is no excuse to run stale code [#3164].
 * A checkout whose .git is a file is a linked worktree; there one rev-parse and one ancestry check
 * run, and any failure keeps this worktree's code with a reason.
 */
export function currentEntry(entry, cwd = process.cwd(), env = process.env) {
  if (env.PULLBOARD_OWN_CLI === '1') return null;
  // A serve replacement holds its predecessor's socket on descriptor 3 and an IPC channel (PULLBOARD_SERVE_FD, drive's SERVE_FD_ENV):
  // the handover passes only descriptors 0-2, so main's entry would listen on a non-socket and fail ENOTTY [C7,#12301].
  if (env.PULLBOARD_SERVE_FD !== undefined) return null;
  const own = real(dirname(dirname(dirname(entry)))), here = real(cwd); // apps/cli/pullboard.js sits three levels below the root [V32]
  if (!own || !here) return null;
  let marker;
  try { marker = fs.stat(join(own, '.git')); } catch { return null; }
  if (!marker.isFile()) return null;
  if (here !== own && !here.startsWith(own + sep) && !sameRepository(own, here)) return null;
  // Git's own files name the checkout and its Git directories; Git is asked only when they cannot (#6170).
  const files = gitLocation(own, { walk: false });
  const located = files ? { status: 0, stdout: `${files.root}\n${files.gitDir}\n${files.commonDir}` }
    : git(own, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  if (located.status !== 0) return { why: 'git could not locate the main checkout' };
  const [top, gitDir, commonDir] = located.stdout.trim().split('\n');
  if (!top || !gitDir || !commonDir || real(top) !== own || real(gitDir) === real(commonDir)
    || basename(commonDir) !== '.git') return { why: 'this checkout is not a linked worktree of a main checkout' };
  const mainRoot = dirname(commonDir);
  const target = join(mainRoot, 'apps/cli/pullboard.js');
  if (real(mainRoot) === own) return null;
  try { fs.access(target, fs.constants.R_OK); } catch { return { why: `${target} is missing or unreadable` }; }
  const ancestry = git(own, ['merge-base', '--is-ancestor', 'main-worktree/HEAD', 'HEAD']);
  if (ancestry.status === 0) return null;
  return ancestry.status === 1 ? { target } : { why: 'git could not compare this worktree with main' };
}

/** Whether two checkouts share one Git common directory, so they are checkouts of the same repository. */
function sameRepository(own, here) {
  const common = cwd => {
    const files = gitLocation(cwd);
    if (files) return real(files.commonDir);
    const result = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return result.status === 0 ? real(result.stdout.trim()) : null;
  };
  const mine = common(own);
  return Boolean(mine) && mine === common(here);
}

/** Say in one stderr line why this worktree runs its own code; the command itself never fails for it. */
function fallBack(why) {
  try { process.stderr.write(`pullboard: main checkout CLI not found; running this worktree's code (${why})\n`); } catch { /* the command still runs */ }
  return null;
}

/**
 * Run the main checkout's entry with this command's arguments, cwd and environment when this
 * worktree is behind, and return its exit status; null means this entry runs the command itself.
 */
export function runCurrentCli(entry) {
  let decision;
  try { decision = currentEntry(entry); } catch (error) { return fallBack(error.message); }
  if (!decision) return null;
  if (decision.why) return fallBack(decision.why);
  const result = spawnSync(process.execPath, [...process.execArgv, decision.target, ...process.argv.slice(2)],
    { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  if (result.error) return fallBack(`could not start ${decision.target}: ${result.error.message}`);
  if (result.signal) process.kill(process.pid, result.signal);
  return result.status ?? 1;
}
