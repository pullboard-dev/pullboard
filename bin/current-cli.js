/**
 * Agents run the board's current CLI: an entry started in a linked worktree whose HEAD is behind
 * the main checkout hands the command to the main checkout's entry [B17,B3,B34].
 * Worktrees fall hundreds of commits behind while their agents build, and landed fixes to the
 * CLI and its hooks must reach them at once, not at their next rebase.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

/** Run Git for this check only, never steered by a hook's GIT_DIR or GIT_INDEX_FILE. */
function git(cwd, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return spawnSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Resolve a path through symlinks, or null when it is gone. */
function real(path) {
  try { return realpathSync(path); } catch { return null; }
}

/**
 * Decide whether this entry hands the command to the main checkout's entry: { target } to hand
 * over, { why } when it should but cannot, or null when this entry is the right code to run.
 * Silent cases: the opt-out, a cwd outside this entry's own checkout (another repo, as test fixtures
 * use), and the main checkout itself, whose .git is a directory, so the main entry never recurses.
 * A checkout whose .git is a file is a linked worktree; there one rev-parse and one ancestry check
 * run, and any failure keeps this worktree's code with a reason.
 */
export function currentEntry(entry, cwd = process.cwd(), env = process.env) {
  if (env.PULLBOARD_OWN_CLI === '1') return null;
  const own = real(dirname(dirname(entry))), here = real(cwd);
  if (!own || !here || (here !== own && !here.startsWith(own + sep))) return null;
  let marker;
  try { marker = statSync(join(own, '.git')); } catch { return null; }
  if (!marker.isFile()) return null;
  const located = git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  if (located.status !== 0) return { why: 'git could not locate the main checkout' };
  const [top, gitDir, commonDir] = located.stdout.trim().split('\n');
  if (!top || !gitDir || !commonDir || real(top) !== own || real(gitDir) === real(commonDir)
    || basename(commonDir) !== '.git') return { why: 'this checkout is not a linked worktree of a main checkout' };
  const mainRoot = dirname(commonDir);
  const target = join(mainRoot, 'bin', 'pullboard.js');
  if (real(mainRoot) === own) return null;
  try { accessSync(target, constants.R_OK); } catch { return { why: `${target} is missing or unreadable` }; }
  const ancestry = git(cwd, ['merge-base', '--is-ancestor', 'main-worktree/HEAD', 'HEAD']);
  if (ancestry.status === 0) return null;
  return ancestry.status === 1 ? { target } : { why: 'git could not compare this worktree with main' };
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
