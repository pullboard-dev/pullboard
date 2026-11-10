/** Bounded transport health observations never execute or certify a project's tests [C7]. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { recoveryIdentity } from '../../../resources/light.js';
import { openPoolReadOnly } from '../../../resources/light.js';
import { mkdirSync } from 'node:fs';
import { linkSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readlinkSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { statSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { relative } from 'node:path';
import { sep } from 'node:path';
import { join } from 'node:path';
import { parseProcessCensus } from '../../../kernel/light.js';
import { liveJobSet } from './holders.js';
import { sortHolders } from './holders.js';
import { stopOrphanWorkers } from './holders.js';

/** Atomically reserve the same nonce path for worker startup or cancellation; a loser must never launch. */
export function claimRunnerLaunch(root, identity, neverStarted = false) {
  if (!recoveryIdentity(identity) || identity.launchFence !== 1) throw new Error('invalid runner launch identity');
  const directory = join(root, 'recovery-launches');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const claim = join(directory, identity.request);
  try { mkdirSync(claim, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  writeFileSync(join(claim, 'identity.json'), JSON.stringify({ ...identity, neverStarted }) + '\n', { mode: 0o600, flag: 'wx' });
  return true;
}

/** Refuse delayed direct worker entry when its exact installer claim is absent or was cancelled. */
export function runnerLaunchAllowed(root, identity) {
  if (!recoveryIdentity(identity) || identity.launchFence !== 1) return false;
  try {
    const file = join(root, 'recovery-launches', identity.request, 'identity.json');
    if (!statSync(file).isFile() || statSync(file).size > 4096) return false;
    const actual = JSON.parse(readFileSync(file, 'utf8'));
    return actual.neverStarted === false && actual.cancelled !== true && sameRecovery(actual, identity);
  } catch { return false; /* Unknown launch custody never permits a job to start. */ }
}

/** Publish a complete startup owner or cancellation claim atomically; a crash cannot leave an empty winning record. */
function claimStartup(root, identity, payload) {
  const directory = join(root, 'recovery-launches', identity.request);
  const temporary = join(directory, `.startup-${randomUUID()}.json`);
  writeFileSync(temporary, JSON.stringify({ ...identity, ...payload }) + '\n', { flag: 'wx', mode: 0o600 });
  try { linkSync(temporary, join(directory, 'startup.json')); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  finally { unlinkSync(temporary); }
}

/** Claim the same startup boundary that idle cancellation uses, recording custody before work can spawn. */
export function claimRunnerWorker(root, identity, processCensus) {
  if (!runnerLaunchAllowed(root, identity)) return false;
  const owner = processCensus()?.get(process.pid);
  if (!owner) return false;
  try {
    if (!claimStartup(root, identity, { owner: { pid: owner.pid, started: owner.started } })) return false;
    return runnerLaunchAllowed(root, identity);
  } catch { return false; }
}

/** Fence only matching started custody; a live startup owner keeps the hold even before it creates a job. */
function cancelRunnerLaunch(root, identity, processCensus) {
  try {
    if (claimRunnerLaunch(root, identity, true)) return { cancelled: true };
    const directory = join(root, 'recovery-launches', identity.request), file = join(directory, 'identity.json');
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) throw new Error('invalid launch custody');
    const actual = JSON.parse(readFileSync(file, 'utf8'));
    if (!sameRecovery(actual, identity)) throw new Error('foreign launch custody');
    if (actual.neverStarted === true) return { cancelled: true };
    if (actual.neverStarted !== false && actual.cancelled !== true) throw new Error('unknown launch state');
    if (!claimStartup(root, identity, { cancelled: true })) {
      const startup = join(directory, 'startup.json'), entry = lstatSync(startup);
      if (!entry.isFile() || entry.size > 4096) throw new Error('invalid startup custody');
      const state = JSON.parse(readFileSync(startup, 'utf8'));
      if (!sameRecovery(state, identity)) throw new Error('foreign startup custody');
      if (state.cancelled !== true) {
        const owner = state.owner;
        if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || typeof owner.started !== 'string' || !owner.started.trim()) throw new Error('unknown startup owner');
        const census = processCensus(), observed = census?.get(owner.pid);
        if (!census) return { cancelled: false, reason: `runner startup pid ${owner.pid} could not be verified` };
        if (observed && !observed.state.startsWith('Z') && observed.started === owner.started)
          return { cancelled: false, reason: `runner process or job working directory remains: startup pid ${owner.pid}` };
        if (!observed) {
          try { process.kill(owner.pid, 0); return { cancelled: false, reason: `runner startup pid ${owner.pid} could not be verified` }; }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
    }
    // Omitting neverStarted fences older workers too, without falsely claiming this request never started.
    const { neverStarted, ...retained } = actual;
    const temporary = join(directory, `.cancelled-${randomUUID()}.json`);
    writeFileSync(temporary, JSON.stringify({ ...retained, cancelled: true, priorNeverStarted: actual.priorNeverStarted ?? neverStarted }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
    return { cancelled: true };
  } catch { return { cancelled: false, reason: 'exact launch cancellation custody could not be verified' }; }
}

/** Persist verified process/lease drainage before removing the last observable job directory. */
export function recordRunnerCompletion(root, identity, job) {
  if (!recoveryIdentity(identity) || typeof job !== 'string' || !job.startsWith(identity.request + '-')
    || !/^[A-Za-z0-9]{6}$/u.test(job.slice(identity.request.length + 1))) return;
  const directory = join(root, 'recovery');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, identity.request + '.json');
  const temporary = file + '.tmp';
  writeFileSync(temporary, JSON.stringify({ ...identity, drained: true, job }) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** Require exact identity equality without interpreting an unrelated filesystem record as this request. */
function sameRecovery(actual, expected) {
  return recoveryIdentity(actual) && (actual.launchFence ?? 0) === (expected.launchFence ?? 0) && ['request', 'nonce', 'tooling'].every(key => actual[key] === expected[key]);
}

/** Observe an exact startup owner without cancelling, cleaning or signalling that remote job. */
export function runnerJobReply(root, request, { census = processCensus, inspect = pid => process.kill(pid, 0) } = {}) {
  const base = { version: 1, nonce: request?.nonce, worker: true, job: request?.job,
    recovery: request?.recovery, state: 'unknown', cleanup: false };
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(request?.job ?? '') || !recoveryIdentity(request?.recovery)
    || request.job !== request.recovery.request) return base;
  try {
    const directory = join(root, 'recovery-launches', request.recovery.request);
    const file = join(directory, 'startup.json'), stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) return base;
    const startup = JSON.parse(readFileSync(file, 'utf8'));
    const owner = startup.owner;
    if (!sameRecovery(startup, request.recovery) || !Number.isSafeInteger(owner?.pid) || owner.pid < 1
      || typeof owner.started !== 'string' || !Number.isFinite(Date.parse(owner.started))) return base;
    const observed = census();
    if (!observed) return base;
    const row = observed.get(owner.pid);
    if (row) {
      if (row.pid !== owner.pid || typeof row.started !== 'string' || !Number.isFinite(Date.parse(row.started)) || typeof row.state !== 'string' || !row.state) return base;
      return { ...base, owner, state: row.started !== owner.started || row.state.startsWith('Z') ? 'gone' : 'running' };
    }
    try { inspect(owner.pid); } catch (error) { if (error.code === 'ESRCH') return { ...base, owner, state: 'gone' }; }
    return base;
  } catch { return base; /* Missing, foreign or unreadable custody is never positive absence. */ }
}

/** A fresh pinned worker proves exact drained jobs absent, or atomically fences a never-started request. */
export function runnerHealthReply(root, request) {
  const base = { version: 1, nonce: request?.nonce, worker: true, cleanup: false };
  const identities = Array.isArray(request?.previous) ? request.previous : [request?.previous];
  if (!identities.length || identities.length > 128 || !identities.every(recoveryIdentity)) return { ...base, reason: 'missing exact request ID or completion record' };
  for (const identity of identities) {
    try {
      const file = join(root, 'recovery', identity.request + '.json');
      if (!statSync(file).isFile() || statSync(file).size > 4096) return { ...base, reason: 'invalid exact drainage record' };
      const actual = JSON.parse(readFileSync(file, 'utf8'));
      if (sameRecovery(actual, identity)) {
        // The earlier complete-record format was written only after actual job-file removal.
        if (actual.clean === true && actual.drained === undefined) continue;
        if (actual.drained === true && typeof actual.job === 'string' && actual.job.startsWith(identity.request + '-')
          && /^[A-Za-z0-9]{6}$/u.test(actual.job.slice(identity.request.length + 1))) {
          try { lstatSync(join(root, 'jobs', actual.job)); }
          catch (error) { if (error.code === 'ENOENT') continue; return { ...base, reason: 'exact job-directory absence could not be verified' }; }
          return { ...base, reason: 'exact job files are still present' };
        }
        return { ...base, reason: 'invalid exact job-directory binding' };
      }
    } catch { /* Absence of a completion record alone proves nothing; the atomic launch fence decides below. */ }
    if (identity.launchFence !== 1) return { ...base, reason: 'missing completion record for request predating the launch fence' };
    try {
      if (claimRunnerLaunch(root, identity, true)) continue;
      const claim = join(root, 'recovery-launches', identity.request, 'identity.json');
      if (!statSync(claim).isFile() || statSync(claim).size > 4096) return { ...base, reason: 'invalid launch custody record' };
      const actual = JSON.parse(readFileSync(claim, 'utf8'));
      if (actual.neverStarted === true && sameRecovery(actual, identity)) continue;
      if (sameRecovery(actual, identity) && (actual.neverStarted === false || actual.cancelled === true))
        return { ...base, idleRequired: true, reason: 'started request has no exact completion record' };
      return { ...base, reason: 'launch custody does not match the exact request' };
    } catch { /* An unknown claim, incomplete write or permission failure remains unavailable. */ }
    return { ...base, reason: 'started request has no exact completion record' };
  }
  return { ...base, cleanup: true, reason: 'exact jobs drained or atomically fenced before startup' };
}

/** Bind a running worker to its own job directory before it can wait for a resource lease. */
export function recordRunnerOwner(directory, processCensus) {
  const owner = processCensus()?.get(process.pid);
  if (!owner) throw new Error('runner worker process identity could not be observed');
  writeFileSync(join(directory, 'worker-owner.json'), JSON.stringify({ pid: owner.pid, started: owner.started }) + '\n',
    { mode: 0o600, flag: 'wx' });
}

/** Recognize only an actual pinned worker command at the canonical path boundary, excluding health probes. */
export function runnerWorkerMatcher(root, { exactEntrypoint = false, includeLegacy = true } = {}) {
  const canonicalRoot = realpathSync(root);
  const roots = [...new Set([root, canonicalRoot])].map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  // The worker entry moved with the layout freeze: apps/runner/src/io/scripts/worker.js inside each pinned runtime [V32].
  const prefix = '(?:' + roots.join('|') + ')/runtime/[a-f0-9]{64}/';
  const source = prefix + 'apps/runner/src/io/scripts/worker\\.js';
  const legacy = prefix + 'src/runner-worker\\.js';
  if (exactEntrypoint) {
    const entry = new RegExp('^' + source + '$', 'u');
    /** A positive entrypoint proof matches the complete argv path, never the conservative busy substring. */
    return command => entry.exec(command)?.[0] === command;
  }
  const entries = includeLegacy ? '(?:' + source + '|' + legacy + ')' : source;
  const entry = new RegExp('(?:^|\\s|["\'])' + entries + '(?=\\s|$)', 'u');
  /** Keep selection and the canonical idle guard on the same exact worker predicate. */
  return command => {
    const worker = entry.exec(command);
    return Boolean(worker && !/^\s+--health(?:\s|$)/u.test(command.slice(worker.index + worker[0].length)));
  };
}

/** Observe live owners and job working directories; restart may exclude only exact census-bound worker identities from the worker-presence check. */
export function runnerProcessesIdle(root, diagnostic, { ignoredWorkers = [], liveOwners = new Set() } = {}) {
  const options = { encoding: 'utf8', timeout: 2_000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } };
  const commands = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,args='], options);
  if (commands.error || commands.status !== 0 || commands.signal) return false;
  const census = parseProcessCensus(commands.stdout);
  if (!census) return false;
  if (!Array.isArray(ignoredWorkers) || ignoredWorkers.some(expected => {
    const actual = census.get(expected?.pid);
    return !actual || actual.started !== expected.started || actual.processSha256 !== expected.processSha256;
  })) return false;
  const ignored = new Set(ignoredWorkers.map(row => row.pid));
  const pids = [...census.values()].filter(row => row.pid !== process.pid && !row.state.startsWith('Z')).map(row => row.pid);
  const canonicalRoot = realpathSync(root);
  const isWorker = runnerWorkerMatcher(root);
  for (const line of commands.stdout.trim().split('\n')) {
    const row = /^\s*([1-9][0-9]*)\s+\d+\s+\d+\s+[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}\s+\S+\s+(.+)$/u.exec(line);
    if (!row) return false;
    const actual = census.get(Number(row[1]));
    if (!actual || actual.pid === process.pid || actual.state.startsWith('Z')) continue;
    if (isWorker(row[2]) && !ignored.has(actual.pid) && !liveOwners.has(actual.pid)) { diagnostic.pid = actual.pid; return false; }
  }
  const jobs = join(canonicalRoot, 'jobs');
  const liveFolders = new Set();
  let directories;
  try { directories = readdirSync(jobs, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') return false; directories = []; }
  for (const entry of directories) {
    if (!entry.isDirectory()) continue;
    const file = join(jobs, entry.name, 'worker-owner.json');
    try {
      if (!lstatSync(file).isFile() || lstatSync(file).size > 4096) return false;
      const owner = JSON.parse(readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.started !== 'string' || !owner.started.trim()) return false;
      const actual = census.get(owner.pid);
      if (!actual) {
        try { process.kill(owner.pid, 0); return false; }
        catch (error) { if (error.code !== 'ESRCH') return false; }
      }
      if (actual && !actual.state.startsWith('Z') && actual.started === owner.started) {
        // A live controller job's own folder is its slot, not a leak; its processes are spared below too.
        if (liveOwners.has(actual.pid)) { liveFolders.add(entry.name); continue; }
        diagnostic.pid = actual.pid; return false;
      }
    } catch (error) { if (error.code !== 'ENOENT') return false; }
  }
  /** Compare directory components so jobs-old never counts as a running job. */
  const inJobs = path => {
    const part = relative(jobs, path);
    return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part) && !liveFolders.has(part.split(sep)[0]);
  };
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        if (statSync(`/proc/${pid}`).uid === process.getuid() && inJobs(readlinkSync(`/proc/${pid}/cwd`))) { diagnostic.pid = pid; return false; }
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) return false; }
    }
    return true;
  }
  if (process.platform !== 'darwin') return false;
  const observed = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-u', String(process.getuid()), '-d', 'cwd', '-Fpn'], options);
  // lsof warns on stderr about a file system it cannot stat (an NFS volume on vanilla) and still lists every cwd;
  // only a line outside such a WARNING block is an error. The warning alone kept the largest runner "unverifiable" [C7].
  const errors = observed.stderr.split('\n').filter(line => line.trim() && !/^lsof: WARNING:/u.test(line) && !/^\s/u.test(line));
  if (observed.error || observed.status !== 0 || observed.signal || errors.length) return false;
  let pid = null, ownSeen = false, complete = false;
  for (const line of observed.stdout.trim().split('\n')) {
    if (/^p[1-9][0-9]*$/u.test(line)) {
      if (pid !== null && !complete) return false;
      pid = Number(line.slice(1)); complete = false;
    } else if (line === 'fcwd' && pid !== null && !complete) continue;
    else if (line.startsWith('n') && pid !== null && !complete && isAbsolute(line.slice(1))) {
      if (inJobs(line.slice(1))) { diagnostic.pid = pid; return false; }
      ownSeen ||= pid === process.pid; complete = true;
    } else return false;
  }
  return ownSeen && complete;
}

/** A holder's process still exists (or cannot be checked); a pid the kernel no longer knows is a dead holder. */
export function holderProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** Attest an idle pinned worker and writable root without guessing a missing job's identity. */
export function runnerIdleReply(root, request, processCensus, orphanObserver = null) {
  const base = { version: 1, nonce: request?.nonce, worker: true, idle: false, writable: false };
  try {
    if (!/^[a-f0-9-]{36}$/u.test(request?.nonce ?? '') || !statSync(root).isDirectory())
      return { ...base, reason: 'runner root is unavailable' };
    if (request.previous !== undefined) {
      const identities = Array.isArray(request.previous) ? request.previous : [request.previous];
      if (!identities.length || identities.length > 128 || !identities.every(identity => recoveryIdentity(identity) && identity.launchFence === 1))
        return { ...base, reason: 'exact launch identities are required before idle fallback' };
      for (const identity of identities) {
        const result = cancelRunnerLaunch(root, identity, processCensus);
        if (!result.cancelled) return { ...base, reason: result.reason };
      }
    }
    const jobs = join(root, 'jobs');
    let jobDirectory;
    try { jobDirectory = lstatSync(jobs); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (jobDirectory && !jobDirectory.isDirectory()) return { ...base, reason: 'runner jobs location is not a directory' };
    const home = isAbsolute(process.env.HOME || '') ? process.env.HOME : userInfo().homedir;
    const machineHome = process.env.PULLBOARD_MACHINE_HOME ?? join(home, '.pullboard');
    if (!isAbsolute(machineHome)) return { ...base, reason: 'runner resource location is unknown' };
    const file = join(machineHome, 'resources.sqlite');
    let resourceFile;
    try { resourceFile = lstatSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const liveOwners = new Set();
    if (resourceFile) {
      if (!resourceFile.isFile()) return { ...base, reason: 'runner resource location is not a file' };
      const db = openPoolReadOnly(file, 1_000);
      let holders;
      try {
        // A holder whose process is gone is a leak the machine reclaims on its next write; it must not keep the
        // runner "busy" forever, which idled the largest runner for a day on three dead pids [C7].
        // Every column, since an older or minimal holder table may lack pid; a holder without one still counts as active.
        holders = db.prepare("SELECT * FROM holder WHERE name='gate' OR agent LIKE 'pullboard-ssh-%'").all();
      } finally { db.close(); }
      // The controller's live jobs cost only their own slots; a worker it no longer owns is stopped (runner-orphan-holders.js).
      const sorted = sortHolders(holders, liveJobSet(request), { alive: holderProcessAlive, ...(orphanObserver ? { clientOf: orphanObserver.clientOf } : {}) });
      if (sorted.orphans.length) {
        const stopped = stopOrphanWorkers(sorted.orphans, runnerWorkerMatcher(root, { includeLegacy: false }), orphanObserver);
        return { ...base, reason: `orphaned runner worker stopped: pid ${stopped.join(', ') || 'none signalled'}; idle is proven on the next probe`, orphansStopped: stopped };
      }
      if (sorted.blocking.length) return { ...base, reason: 'runner resource lease is active' };
      for (const holder of sorted.liveSlots) liveOwners.add(holder.pid);
    }
    const marker = join(root, `.idle-probe-${request.nonce}`);
    writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
    unlinkSync(marker);
    try { jobDirectory = lstatSync(jobs); }
    catch (error) { if (error.code !== 'ENOENT') throw error; jobDirectory = null; }
    const diagnostic = {};
    if (jobDirectory && !jobDirectory.isDirectory() || !runnerProcessesIdle(root, diagnostic, { liveOwners }))
      return { ...base, reason: Number.isSafeInteger(diagnostic.pid)
        ? `runner process or job working directory remains: pid ${diagnostic.pid}`
        : 'runner process or job working directory appeared or could not be verified' };
    return { ...base, idle: true, writable: true, reason: liveOwners.size ? `free slots idle beside ${liveOwners.size} live controller job(s) and runner root writable`
      : 'no live runner process, job working directory or resource lease and runner root writable' };
  } catch { return { ...base, reason: 'runner idle or writable state could not be verified' }; }
}
