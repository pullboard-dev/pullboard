/** Background git maintenance for the repo Pullboard manages: register it and schedule it through git's own --scheduler choice [C7,#10782]. */
import { gitSpawnSync } from '../../../../../packages/git/light.js';
import { realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  resolve,
} from 'node:path';

/** True when git has no global config here (GIT_CONFIG_GLOBAL is the null device), so nothing can be registered for the scheduler to find. */
function noGlobalConfig(env) {
  return ['/dev/null', 'nul'].includes(String(env.GIT_CONFIG_GLOBAL ?? '').toLowerCase());
}

/** Run one git command with this environment; never throws. */
function runGit(root, args, env) {
  const ran = gitSpawnSync(args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { status: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: String(ran.stderr || ran.error?.message || '').trim() };
}

/** The command a person runs by hand when nothing schedules maintenance. */
export function maintenanceByHand(root) {
  return `git -C "${root}" maintenance run --schedule=daily`;
}

/**
 * Register the repo for git maintenance (incremental strategy, prefetch off, no foreground auto
 * maintenance) and schedule it with git's own --scheduler choice: auto is launchd on macOS, the Task
 * Scheduler on Windows, and a systemd user timer or else cron on Linux. Registration comes first and must succeed before any scheduler is
 * touched. A runner job never touches the machine's scheduler unless git's own test scheduler
 * (GIT_TEST_MAINT_SCHEDULER) replaces it. Never throws: init goes on whatever happens here.
 *
 * @param {string} root - The repo's working tree.
 * @param {{ env?: NodeJS.ProcessEnv, scheduler?: string, git?: (root: string, args: string[], env: NodeJS.ProcessEnv) => { status: number, stdout: string, stderr: string } }} [ports]
 * @returns {{ state: 'off' | 'scheduled' | 'unscheduled', scheduler?: string, reason?: string, byHand?: string }}
 */
export function scheduleGitMaintenance(root, { env = process.env, scheduler = 'auto', git = runGit } = {}) {
  try {
    if (noGlobalConfig(env)) return { state: 'off', reason: 'git has no global config here' };
    const unset = key => git(root, ['config', '--local', '--get', key], env).status !== 0;
    for (const [key, value] of [['maintenance.strategy', 'incremental'], ['maintenance.prefetch.enabled', 'false'], ['maintenance.auto', 'false']]) {
      if (unset(key)) git(root, ['config', '--local', key, value], env);
    }
    const unscheduled = reason => ({ state: 'unscheduled', reason, byHand: maintenanceByHand(root) });
    const registered = git(root, ['maintenance', 'register'], env);
    if (registered.status !== 0) return unscheduled(registered.stderr.split('\n').pop() || 'git maintenance register failed');
    if (env.PULLBOARD_RUNNER_JOB && !env.GIT_TEST_MAINT_SCHEDULER) return unscheduled('a runner job never touches the machine scheduler');
    const started = git(root, ['maintenance', 'start', `--scheduler=${scheduler}`], env);
    if (started.status === 0) return { state: 'scheduled', scheduler };
    return unscheduled(started.stderr.split('\n').pop() || `git maintenance start --scheduler=${scheduler} failed`);
  } catch (error) {
    return { state: 'unscheduled', reason: error.message, byHand: maintenanceByHand(root) };
  }
}

/** The one line init prints about maintenance, or null: a scheduled repo says so only when verbose. */
export function maintenanceLine(outcome, { verbose = false } = {}) {
  if (outcome.state === 'unscheduled') return `git maintenance is not scheduled on this machine (${outcome.reason}); run it by hand: ${outcome.byHand}`;
  if (outcome.state === 'scheduled' && verbose) return 'git maintenance scheduled for this repo (incremental, prefetch off)';
  return null;
}

/** A path's real form, or the path itself when it cannot be resolved. */
function real(path) {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Doctor's finding when the managed repo is not registered for git maintenance, or null. A linked
 * worktree counts as registered when its main worktree is. Silent where git has no global config.
 *
 * @param {string} root - The working tree doctor runs in.
 * @param {string} commonDir - The repo's common git directory.
 * @param {{ env?: NodeJS.ProcessEnv, git?: typeof runGit }} [ports]
 * @returns {{ code: string, message: string, next: string } | null}
 */
export function gitMaintenanceProblem(root, commonDir, { env = process.env, git = runGit } = {}) {
  if (noGlobalConfig(env)) return null;
  const listed = git(root, ['config', '--global', '--get-all', 'maintenance.repo'], env);
  const registered = new Set(listed.stdout.split('\n').filter(Boolean).map(real));
  const common = resolve(root, commonDir);
  const main = basename(common) === '.git' ? dirname(common) : root;
  if ([root, main].some(path => registered.has(real(path)))) return null;
  return { code: 'GIT_MAINTENANCE_UNREGISTERED',
    message: `git maintenance is not registered for ${main}, so loose objects pile up and the commit graph goes stale`,
    next: `run git -C "${main}" config maintenance.prefetch.enabled false, then git -C "${main}" maintenance start` };
}
