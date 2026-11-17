/** One repository-owned timer waits without session custody; fresh native CLI code performs the sweep [B3,C7]. */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { closeSync } from 'node:fs';
import { fstatSync } from 'node:fs';
import { openSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { readSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { fsyncSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { AGENT_SESSION_IDS } from '../../../../../packages/kernel/light.js';
import { AGENT_SHELL_MARKERS } from '../../../../../packages/kernel/light.js';
import { cleanGitEnvironment } from '../../../../../packages/git/light.js';
import { git } from '../../../../../packages/git/light.js';
import { gitChildEnv } from '../../../../../packages/git/light.js';
import { repoInfo } from '../../../../../packages/git/light.js';
import { withGitFacts } from '../../../../../packages/git/light.js';
import { timerFiles as auditTimerFiles } from '../../../../../packages/gate/index.js';
import { mainPolicy } from '../../../../../packages/sandbox/light.js';
import { withFileLock } from '../../../../../packages/outbox/light.js';

const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const NOFOLLOW = constants.O_NOFOLLOW;
const TIMER = { label: 'tool build gate timer', folder: 'tool-build-scheduler' };

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

/** The accepted primary checkout and committed main policy are reread in a new Git fact scope. */
async function canonical(ctx) {
  return withGitFacts(() => {
    const info = repoInfo(ctx.info.root), common = realpathSync(info.commonDir);
    if (common !== realpathSync(ctx.info.commonDir)) throw new Error('tool build gate timer repository changed');
    const policy = mainPolicy(info.root);
    if (policy.config.toolBuild?.autoGate !== true) return null;
    const first = git(info.root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0')[0].split('\0');
    if (!first[0]?.startsWith('worktree ') || first.includes('bare')) throw new Error('tool build gate needs the primary checkout');
    const root = first[0].slice('worktree '.length);
    if (!isAbsolute(root)) throw new Error('invalid primary tool build gate checkout');
    const primary = repoInfo(root);
    if (!primary.isMain || realpathSync(primary.commonDir) !== common) throw new Error('tool build gate primary repository changed');
    return { root: realpathSync(root), common, everyMs: policy.config.toolBuild.refreshMs };
  });
}

/** Only private repository-owned directories and a native SQLite file lock may hold a timer. */
export function timerFiles(common, create, { label, folder }) {
  if (!Number.isInteger(NOFOLLOW)) throw new Error(`${label} needs no-follow file observation`);
  let directory = common;
  for (const name of ['pullboard', folder]) {
    directory = join(directory, name);
    if (create) try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const state = lstatSync(directory);
    if (!state.isDirectory() || state.isSymbolicLink() || name === folder && (state.mode & 0o077))
      throw new Error(`${label} directory is not private`);
  }
  const { guard, timer } = auditTimerFiles(directory);
  if (create) {
    try { closeSync(openSync(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const state = lstatSync(guard);
  if (!state.isFile() || state.isSymbolicLink() || state.mode & 0o077) throw new Error(`${label} lock is not private`);
  return { directory, guard, file: timer };
}

/** Read a bounded private timer registration without following a replacement link. */
export function readTimer(file, { label }) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 4096 || before.mode & 0o077) throw new Error(`invalid private ${label}`);
    const bytes = Buffer.alloc(4097);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) !== 0) length += count;
    if (length > 4096) throw new Error(`${label} exceeds its private record bound`);
    const owner = JSON.parse(bytes.subarray(0, length).toString('utf8')), after = fstatSync(fd);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error(`${label} changed while being read`);
    if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !TOKEN.test(owner.token ?? '')
      || typeof owner.started !== 'string' || !owner.started || !Number.isFinite(Date.parse(owner.dueAt))
      || !isAbsolute(owner.root ?? '') || !isAbsolute(owner.common ?? '')) throw new Error(`invalid ${label} identity`);
    return owner;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Publish the actual child's complete identity while holding the repository timer lock. */
export function writeTimer(file, { label }, owner) {
  const temporary = `${file}.${randomUUID()}.tmp`, bytes = Buffer.from(JSON.stringify(owner) + '\n');
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    for (let offset = 0; offset < bytes.length;) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      if (count < 1) throw new Error(`${label} write made no progress`);
      offset += count;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, file);
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
export async function scheduleToolBuildGate(ctx) {
  if (ctx.config.toolBuild?.autoGate !== true) return { scheduled: false, reason: 'disabled' };
  // A runner job's processes die with the job; a detached timer would outlive it in the job's checkout (#2513).
  if (process.env.PULLBOARD_RUNNER_JOB) return { scheduled: false, reason: 'runner-job' };
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
        if (!state.isFile() || state.mode & 0o077) throw new Error('tool build gate scheduler log is not private');
        stage = 'launch';
        child = spawn(process.execPath, [join(accepted.root, 'apps/cli/pullboard.js'), 'tool-build', '--watch', '--key', token],
          { cwd: accepted.root, env: workerEnvironment(accepted.root), detached: true, stdio: ['ignore', logFd, logFd] });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        const identity = processIdentity(child.pid);
        if (!identity || identity.zombie) throw new Error('tool build gate timer child identity is unknown');
        stage = 'register';
        writeTimer(files.file, TIMER, { version: 1, token, pid: child.pid, started: identity.started, dueAt, root: accepted.root, common: accepted.common });
        return { scheduled: true, dueAt };
      } finally { child?.unref(); closeSync(logFd); }
    });
  } catch (error) {
    error.toolBuildGateStage ??= stage;
    throw error;
  }
}

/** Match the exact registered process and repository, independently of agent identity. */
function owned(owner, token, identity, ctx) {
  return owner?.token === token && owner.pid === process.pid && owner.started === identity.started
    && owner.common === realpathSync(ctx.info.commonDir) && owner.root === realpathSync(ctx.info.root);
}

/** A fresh --watch worker authenticates registration, waits, then delegates to a fresh canonical CLI. */
export async function runScheduledToolBuildGate(ctx, key) {
  if (!TOKEN.test(key ?? '')) return { ran: false, reason: 'unregistered' };
  const identity = processIdentity(process.pid);
  if (!identity || identity.zombie) throw new Error('tool build gate timer cannot observe its own identity');
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
    if (current && (current.common !== owner.common || current.root !== owner.root)) throw new Error('tool build gate timer primary changed');
    // Only this due registration is consumed. The fresh command schedules the next timer after completion.
    unlinkSync(files.file);
    return current;
  });
  if (!accepted) return { ran: false, reason: 'disabled-or-registration-changed' };
  try {
    const child = spawn(process.execPath, [join(accepted.root, 'apps/cli/pullboard.js'), 'gate', '--landing', '--receipt', '--runner-only'],
      { cwd: accepted.root, env: workerEnvironment(accepted.root), stdio: ['ignore', 'inherit', 'inherit'] });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (status, signal) => resolve(signal ? 1 : status ?? 1)); });
    return { ran: true, code };
  } finally {
    // A failed sweep still gets its next ordinary interval; a successful child may already have registered it.
    await scheduleToolBuildGate(ctx);
  }
}

