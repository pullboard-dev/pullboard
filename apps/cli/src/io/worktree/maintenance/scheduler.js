/** One repository-owned timer waits without session custody; fresh native CLI code performs the sweep [B3,C7]. */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { closeSync } from 'node:fs';
import { fstatSync } from 'node:fs';
import { openSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { AGENT_SESSION_IDS } from '../../../../../../packages/kernel/light.js';
import { AGENT_SHELL_MARKERS } from '../../../../../../packages/kernel/light.js';
import { cleanGitEnvironment } from '../../../../../../packages/git/light.js';
import { git } from '../../../../../../packages/git/light.js';
import { gitChildEnv } from '../../../../../../packages/git/light.js';
import { repoInfo } from '../../../../../../packages/git/light.js';
import { withGitFacts } from '../../../../../../packages/git/light.js';
import { mainPolicy } from '../../../../../../packages/sandbox/light.js';
import { withFileLock } from '../../../../../../packages/outbox/light.js';
import { maintenanceTimerWarning } from './diagnostics.js';
import { readMaintenanceLastRun } from './diagnostics.js';
import { maintenanceDurations } from '../../../../../../packages/config/light.js';
import { readTimer } from '../../tool/build.js';
import { timerFiles } from '../../tool/build.js';
import { writeTimer } from '../../tool/build.js';
import { environmentAdapter } from '../../../../../../packages/env/index.js';

const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const NOFOLLOW = constants.O_NOFOLLOW;
const TIMER = { label: 'maintenance timer', folder: 'worktree-maintenance' };

/** Unknown OS observations never justify replacing a live timer. */
function processIdentity(pid) {
  try {
    const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat='], {
      encoding: 'utf8', timeout: 1000, env: { ...cleanGitEnvironment(), TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\s+/u);
    const state = output.pop(), started = output.join(' ');
    return state && started ? { started, zombie: state.startsWith('Z') } : null;
  } catch { return null; /* Missing or unreadable census remains unknown until kill(0) proves absence. */ }
}

/** A missing, reused or zombie PID has no timer custody; unreadable state remains protected. */
function timerState(owner) {
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code === 'ESRCH' ? 'gone' : 'unknown'; }
  const current = processIdentity(owner.pid);
  if (!current) return 'unknown';
  return current.zombie || current.started !== owner.started ? 'gone' : 'live';
}

/**
 * The primary checkout path without listing every registered worktree [C7].
 * A common directory named `.git` belongs to the checkout that contains it, so no `git worktree list` runs
 * (94-144 ms with 458 worktrees); any other layout, such as a bare repository, still asks Git.
 */
function primaryCheckout(root, common) {
  if (basename(common) === '.git') return dirname(common);
  const first = git(root, ['worktree', 'list', '--porcelain', '-z'], { env: cleanGitEnvironment() }).split('\0\0')[0].split('\0');
  if (!first[0]?.startsWith('worktree ') || first.includes('bare')) throw new Error('maintenance needs the primary checkout');
  const path = first[0].slice('worktree '.length);
  if (!isAbsolute(path)) throw new Error('invalid primary maintenance checkout');
  return path;
}

/** The accepted primary checkout and committed main policy are reread in a new Git fact scope. */
async function canonical(ctx) {
  return withGitFacts(() => {
    // An inherited GIT_DIR (hooks, agent shells) must not make the primary checkout look like a linked worktree.
    const info = repoInfo(ctx.info.root, { env: cleanGitEnvironment() }), common = realpathSync(info.commonDir);
    if (common !== realpathSync(ctx.info.commonDir)) throw new Error('maintenance timer repository changed');
    const policy = mainPolicy(info.root);
    if (policy.config.worktreeMaintenance?.enabled !== true) return null;
    const root = primaryCheckout(info.root, common);
    const primary = repoInfo(root, { env: cleanGitEnvironment() });
    if (!primary.isMain || realpathSync(primary.commonDir) !== common) throw new Error('maintenance primary repository changed');
    return { root: realpathSync(root), common, everyMs: maintenanceDurations(policy.config.worktreeMaintenance).everyMs };
  });
}

/** A timer is neither the caller's agent seat nor a holder of foreground resource admission. */
function workerEnvironment(root) {
  const env = gitChildEnv(root);
  for (const key of [...AGENT_SESSION_IDS, ...AGENT_SHELL_MARKERS, 'PULLBOARD_AGENT', 'PULLBOARD_AGENT_ID',
    'PULLBOARD_PARENT_SESSION', 'PULLBOARD_CHECKOUT_SESSION_TOKEN']) delete env[key];
  for (const key of Object.keys(env)) if (/^PULLBOARD_(?:GATE_|BROWSER_SLOT_)/u.test(key)) delete env[key];
  return env;
}

/** Return immediately when disabled; a live or unknown existing timer is never replaced or signalled. */
export async function scheduleWorktreeMaintenance(ctx) {
  if (ctx.config.worktreeMaintenance?.enabled !== true) return { scheduled: false, reason: 'disabled' };
  // A runner job's processes die with the job; a detached timer would outlive it in the job's checkout (#2513).
  if (environmentAdapter().get('PULLBOARD_RUNNER_JOB')) return { scheduled: false, reason: 'runner-job' };
  let stage = 'lookup';
  try {
    const current = await canonical(ctx);
    if (!current) return { scheduled: false, reason: 'disabled-on-main' };
    stage = 'register';
    const files = timerFiles(current.common, true, TIMER);
    return await withFileLock(files.guard, async () => {
      stage = 'lookup';
      const old = readTimer(files.file, TIMER);
      if (old && timerState(old) !== 'gone') return { scheduled: false, reason: 'existing-timer', dueAt: old.dueAt };
      // Main may have changed while this command waited for the repository lock.
      const accepted = await canonical(ctx);
      if (!accepted || accepted.common !== current.common || accepted.root !== current.root) return { scheduled: false, reason: 'policy-changed' };
      stage = 'register';
      const token = randomUUID(), dueAt = new Date(Date.now() + accepted.everyMs).toISOString();
      const log = join(files.directory, 'scheduler.log');
      const logFd = openSync(log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW, 0o600);
      let child;
      try {
        const state = fstatSync(logFd);
        if (!state.isFile() || state.mode & 0o077) throw new Error('maintenance scheduler log is not private');
        stage = 'launch';
        child = spawn(process.execPath, [join(accepted.root, 'apps/cli/pullboard.js'), 'maintenance', '--watch', '--key', token],
          { cwd: accepted.root, env: workerEnvironment(accepted.root), detached: true, stdio: ['ignore', logFd, logFd] });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        const identity = processIdentity(child.pid);
        if (!identity || identity.zombie) throw new Error('maintenance timer child identity is unknown');
        stage = 'register';
        writeTimer(files.file, TIMER, { version: 1, token, pid: child.pid, started: identity.started, dueAt, root: accepted.root, common: accepted.common });
        return { scheduled: true, dueAt };
      } finally { child?.unref(); closeSync(logFd); }
    });
  } catch (error) {
    // The primary checkout owns the timer and reports a real failure once; a linked worktree stays quiet [#2909].
    if (ctx.info.isMain === false) return { scheduled: false, reason: 'linked-worktree-unavailable' };
    error.maintenanceStage ??= stage;
    throw error;
  }
}

/** Match the exact registered process and repository, independently of agent identity. */
function owned(owner, token, identity, ctx) {
  return owner?.token === token && owner.pid === process.pid && owner.started === identity.started
    && owner.common === realpathSync(ctx.info.commonDir) && owner.root === realpathSync(ctx.info.root);
}

/** A fresh --watch worker authenticates registration, waits, then delegates to a fresh canonical CLI. */
export async function runScheduledMaintenance(ctx, key) {
  if (!TOKEN.test(key ?? '')) return { ran: false, reason: 'unregistered' };
  const identity = processIdentity(process.pid);
  if (!identity || identity.zombie) throw new Error('maintenance timer cannot observe its own identity');
  const files = timerFiles(realpathSync(ctx.info.commonDir), false, TIMER);
  let owner;
  // The parent records the spawned PID/start after spawn; never act before that exact registration arrives.
  const registrationDeadline = Date.now() + 5000;
  do {
    owner = readTimer(files.file, TIMER);
    if (owned(owner, key, identity, ctx)) break;
    if (Date.now() >= registrationDeadline) return { ran: false, reason: 'unregistered' };
    await pause(25);
  } while (true);
  const due = Date.parse(owner.dueAt);
  while (Date.now() < due) {
    await pause(Math.min(due - Date.now(), 60_000));
    const latest = readTimer(files.file, TIMER);
    if (!owned(latest, key, identity, ctx) || latest.dueAt !== owner.dueAt) return { ran: false, reason: 'registration-changed' };
  }
  const accepted = await withFileLock(files.guard, async () => {
    const latest = readTimer(files.file, TIMER);
    if (!owned(latest, key, identity, ctx) || latest.dueAt !== owner.dueAt || Date.parse(latest.dueAt) > Date.now()) return null;
    const current = await canonical(ctx);
    if (current && (current.common !== owner.common || current.root !== owner.root)) throw new Error('maintenance timer primary changed');
    // Only this due registration is consumed. The fresh command schedules the next timer after completion.
    unlinkSync(files.file);
    return current;
  });
  if (!accepted) return { ran: false, reason: 'disabled-or-registration-changed' };
  try {
    const child = spawn(process.execPath, [join(accepted.root, 'apps/cli/pullboard.js'), 'maintenance'],
      { cwd: accepted.root, env: workerEnvironment(accepted.root), stdio: ['ignore', 'inherit', 'inherit'] });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (status, signal) => resolve(signal ? 1 : status ?? 1)); });
    return { ran: true, code };
  } finally {
    // A failed sweep still gets its next ordinary interval; a successful child may already have registered it.
    await scheduleWorktreeMaintenance(ctx);
  }
}

/** Read existing timer identity and last completed run without creating, replacing or signalling anything. */
export function maintenanceTimerHealth(common) {
  try {
    const files = timerFiles(realpathSync(common), false, TIMER), owner = readTimer(files.file, TIMER);
    return { state: owner ? timerState(owner) : 'absent', key: owner ? createHash('sha256').update(owner.token).digest('hex') : null,
      pid: owner?.pid ?? null, dueAt: owner?.dueAt ?? null, lastRun: readMaintenanceLastRun(common) };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent', key: null, pid: null, dueAt: null, lastRun: null };
    return { state: 'unavailable', key: null, pid: null, lastRun: null, cause: maintenanceTimerWarning(error) };
  }
}
