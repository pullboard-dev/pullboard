import { processCensus } from '../custody.js';
import { orphanObserver } from '../orphans.js';
/** Answer the controller's health request from the worker's own runner root [C7]. */
import { runnerHealthReply } from '../../../../../packages/runners/light.js';
import { runnerIdleReply } from '../../../../../packages/runners/light.js';
import { runnerJobReply } from '../../../../../packages/runners/light.js';
import { runnerProcessesIdle } from '../../../../../packages/runners/light.js';
import { runnerWorkerMatcher } from '../../../../../packages/runners/light.js';
import { holderProcessAlive } from '../../../../../packages/runners/light.js';
import { parseProcessCensus } from '../../../../../packages/kernel/light.js';
import { exactStart } from '../../../../../packages/gate/light.js';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { userInfo } from 'node:os';
import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/** Print one health or idle reply for a base64 request, exiting non-zero when the request is not exact. */
export function serveHealth(encodedRequest) {
  try {
    const { request, root } = readRequest(encodedRequest);
    process.stdout.write(JSON.stringify(request.job !== undefined ? runnerJobReply(root, request, { census: processCensus })
      : request.idle === true ? runnerIdleReply(root, request, processCensus, orphanObserver) : runnerHealthReply(root, request)) + '\n');
  } catch { process.exitCode = 1; }
}

/** Decode and validate one base64 health request and resolve the runner root it names. */
function readRequest(encodedRequest) {
  const request = JSON.parse(Buffer.from(encodedRequest ?? '', 'base64').toString('utf8'));
  if (!/^[a-f0-9-]{36}$/u.test(request.nonce ?? '') || request.root !== undefined && !isAbsolute(request.root)) throw new Error('invalid health request');
  return { request, root: request.root ?? join(isAbsolute(process.env.HOME || '') ? process.env.HOME : userInfo().homedir, '.pullboard-runner') };
}

/** Preserve the exact failing observation instead of treating unknown custody as an empty runner. */
function unknown(diagnostic, reason, error) {
  diagnostic.reason = reason + (error?.code ? ' [' + error.code + ']' : '') + (error?.message ? ': ' + error.message : '');
  return null;
}

// Installed SDK proc_pidpath uses proc_info(2, pid, flavor 11, 0, buffer, 4096); raw success is status 0, not strlen.
const PERL_EXECUTABLE = `exit 1 unless @ARGV == 1 && $ARGV[0] =~ /\\A[1-9][0-9]{0,9}\\z/;
my $pid = 0 + $ARGV[0]; exit 1 if $pid > 2147483647;
my $buf = "\\0" x 4096; my $n = syscall(336, 2, $pid, 11, 0, $buf, length($buf));
exit 1 if $n != 0; my $nul = index($buf, "\\0");
exit 1 if $nul < 1 || $nul >= length($buf); print substr($buf, 0, $nul);`;

/** Prove the OS executable itself is this trusted Node, independently of caller-controlled argv0. */
function workerExecutableMatches(pid) {
  try {
    let executable;
    if (process.platform === 'linux') executable = fs.realpath('/proc/' + pid + '/exe');
    else if (process.platform === 'darwin') {
      const result = spawnSync('/usr/bin/perl', ['-e', PERL_EXECUTABLE, String(pid)], { encoding: 'utf8', timeout: 2_000,
        maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
      if (result.error || result.status !== 0 || result.signal || typeof result.stdout !== 'string'
        || !result.stdout || Buffer.byteLength(result.stdout) >= 4096 || result.stdout.includes('\0')) return false;
      executable = result.stdout;
    } else return false;
    return isAbsolute(executable) && fs.realpath(executable) === fs.realpath(process.execPath);
  } catch { return false; }
}

/** Accept only the ordinary launcher's Node executable followed immediately by its sole worker entrypoint. */
function ordinaryWorkerCommand(command, isEntrypoint, pid) {
  let words;
  if (process.platform === 'linux') {
    try {
      const bytes = fs.readFile('/proc/' + pid + '/cmdline', null);
      if (!bytes.length || bytes.at(-1) !== 0) return false;
      words = bytes.toString('utf8').slice(0, -1).split('\0');
    } catch { return false; }
  } else if (process.platform === 'darwin') {
    // ps has no argv framing: accept only the trusted direct two-path shape without ambiguous path/quote characters.
    words = command.trim().split(/\s+/u);
    if (words.some(word => /[\s'"\\]/u.test(word))) return false;
  } else return false;
  if (words.length !== 2 || !isEntrypoint(words[1]) || !workerExecutableMatches(pid)) return false;
  if (words[0] === 'node' || words[0] === process.execPath) return true;
  try { return isAbsolute(words[0]) && fs.realpath(words[0]) === fs.realpath(process.execPath); }
  catch { return false; }
}

/** Observe pinned workers only after complete owner, resource and canonical process/CWD idle proofs. */
function idleWorkerSnapshot(root, diagnostic) {
  const ps = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat=,args='], { encoding: 'utf8', timeout: 2_000,
    maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } });
  if (ps.error || ps.status !== 0 || ps.signal) return unknown(diagnostic, 'process census failed', ps.error);
  const census = parseProcessCensus(ps.stdout);
  if (!census) return unknown(diagnostic, 'process census is malformed');
  let canonical;
  let isWorker, isEntrypoint;
  try {
    canonical = fs.realpath(root);
    isWorker = runnerWorkerMatcher(root);
    isEntrypoint = runnerWorkerMatcher(root, { exactEntrypoint: true });
  }
  catch (error) { return unknown(diagnostic, 'runner root could not be verified', error); }
  const jobs = join(canonical, 'jobs');
  let jobDirectory;
  try { jobDirectory = fs.lstat(jobs); }
  catch (error) { if (error.code !== 'ENOENT') return unknown(diagnostic, 'jobs directory could not be inspected', error); }
  let directories = [];
  if (jobDirectory) {
    if (!jobDirectory.isDirectory()) return unknown(diagnostic, 'jobs location is not a real directory');
    try { directories = fs.list(jobs, { withFileTypes: true }); }
    catch (error) { return unknown(diagnostic, 'jobs directory could not be read', error); }
  }
  for (const directory of directories) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) return unknown(diagnostic, 'jobs entry is not a real directory: ' + directory.name);
    try {
      const file = join(canonical, 'jobs', directory.name, 'worker-owner.json'), stat = fs.lstat(file);
      if (!stat.isFile() || stat.size > 4096) return unknown(diagnostic, 'job owner record is not a bounded regular file: ' + directory.name);
      const text = fs.readFile(file, 'utf8');
      if (Buffer.byteLength(text) > 4096) return unknown(diagnostic, 'job owner record is oversized: ' + directory.name);
      const owner = JSON.parse(text);
      if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || typeof owner.started !== 'string'
        || !/^[A-Z][a-z]{2} [A-Z][a-z]{2} [0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/u.test(owner.started)
        || !Number.isFinite(Date.parse(owner.started))) return unknown(diagnostic, 'job owner PID/start record is malformed: ' + directory.name);
      const actual = census.get(owner.pid);
      if (!actual) {
        try { process.kill(owner.pid, 0); return unknown(diagnostic, 'job owner PID remains unverifiable: ' + owner.pid); }
        catch (error) { if (error.code !== 'ESRCH') return unknown(diagnostic, 'job owner PID could not be checked', error); }
      }
      if (actual && !actual.state.startsWith('Z') && actual.started === owner.started)
        return unknown(diagnostic, 'live job owner remains: pid ' + owner.pid);
    } catch (error) { return unknown(diagnostic, error instanceof SyntaxError ? 'job owner JSON is malformed: ' + directory.name : 'job owner record could not be read: ' + directory.name, error); }
  }
  const home = isAbsolute(process.env.HOME || '') ? process.env.HOME : userInfo().homedir;
  const machineHome = process.env.PULLBOARD_MACHINE_HOME ?? join(home, '.pullboard');
  if (!isAbsolute(machineHome)) return unknown(diagnostic, 'resource database location is not absolute');
  const resourceFile = join(machineHome, 'resources.sqlite');
  let resourceStat;
  try { resourceStat = fs.lstat(resourceFile); }
  catch (error) { if (error.code !== 'ENOENT') return unknown(diagnostic, 'resource database could not be inspected', error); }
  if (resourceStat) {
    if (!resourceStat.isFile()) return unknown(diagnostic, 'resource database is not a regular file');
    try {
      const db = new DatabaseSync(resourceFile, { readOnly: true });
      try {
        // A dead holder is a leak for the machine's next write to reclaim, never proof of work in progress [C7].
        // Every column, since an older or minimal holder table may lack pid; a holder without one still counts as active.
        const holders = db.prepare("SELECT * FROM holder WHERE name='gate' OR agent LIKE 'pullboard-ssh-%'").all();
        if (holders.some(holder => holderProcessAlive(holder.pid))) return unknown(diagnostic, 'runner resource lease is active');
      } finally { db.close(); }
    } catch (error) { return unknown(diagnostic, 'resource SQLite idle query failed', error); }
  }
  const workers = [];
  for (const line of ps.stdout.trim().split('\n')) {
    const row = /^\s*([1-9][0-9]*)\s+\d+\s+\d+\s+[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}\s+\S+\s+(.+)$/u.exec(line);
    if (!row) return unknown(diagnostic, 'process census command row is malformed');
    const actual = census.get(Number(row[1]));
    if (!isWorker(row[2]) || actual?.pid === process.pid || actual?.state.startsWith('Z')) continue;
    if (!actual) return unknown(diagnostic, 'pinned worker identity is absent from census');
    if (!ordinaryWorkerCommand(row[2], isEntrypoint, actual.pid)) return unknown(diagnostic, 'pinned-path command is not the ordinary Node worker entrypoint: pid ' + actual.pid);
    const birth = exactStart(actual.pid);
    if (!birth) return unknown(diagnostic, 'pinned worker exact start is unavailable: pid ' + actual.pid);
    workers.push({ ...actual, birth });
  }
  const canonicalDiagnostic = {};
  if (!runnerProcessesIdle(root, canonicalDiagnostic, { ignoredWorkers: workers }))
    return unknown(diagnostic, 'canonical process/job CWD idle proof refused' + (canonicalDiagnostic.pid ? ': pid ' + canonicalDiagnostic.pid : ''));
  return { census, workers };
}

/** Keep the existing PID-list API, returning null on every unknown observation and retaining its diagnostic. */
export function idleWorkerPids(root, diagnostic = {}) {
  try { return idleWorkerSnapshot(root, diagnostic)?.workers.map(row => row.pid) ?? null; }
  catch (error) { return unknown(diagnostic, 'runner idle observation failed', error); }
}

/** Emit one greppable refusal with the actual runner, root and precise failed observation. */
function restartRefused(root, request, diagnostic, signalAttempts) {
  const reason = diagnostic.reason ?? 'runner restart custody could not be verified';
  process.stderr.write('pullboard runner-restart refused runner=' + JSON.stringify(hostname()) + ' root=' + JSON.stringify(root) + ' reason=' + JSON.stringify(reason) + '\n');
  process.stdout.write(JSON.stringify({ version: 1, nonce: request?.nonce, worker: true, idle: false, writable: false, reason, restarted: [], signalAttempts }) + '\n');
}

/** Reprove all idle custody and exact process identity immediately before each individual signal. */
function signalIdleWorker(root, expected, signal, diagnostic, signalAttempts) {
  const fresh = idleWorkerSnapshot(root, diagnostic);
  if (!fresh) return null;
  const actual = fresh.census.get(expected.pid);
  if (!actual || actual.state.startsWith('Z')) return false;
  const worker = fresh.workers.find(row => row.pid === expected.pid);
  if (!worker || actual.started !== expected.started || actual.processSha256 !== expected.processSha256 || worker.birth !== expected.birth)
    return unknown(diagnostic, 'worker PID identity changed before ' + signal + ': pid ' + expected.pid);
  if (exactStart(expected.pid) !== expected.birth) return unknown(diagnostic, 'worker exact start changed before ' + signal + ': pid ' + expected.pid);
  signalAttempts.push({ pid: expected.pid, signal });
  try { process.kill(expected.pid, signal); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    return unknown(diagnostic, 'worker signal failed before ' + signal + ': pid ' + expected.pid, error);
  }
}

/** Restart only proven idle pinned workers; no later idle result can authorize an earlier signal. */
export function serveRestart(encodedRequest) {
  let root = '(unresolved runner root)', request;
  const diagnostic = {}, signaled = [], signalAttempts = [];
  try {
    ({ request, root } = readRequest(encodedRequest));
    const initial = idleWorkerSnapshot(root, diagnostic);
    if (!initial) return restartRefused(root, request, diagnostic, signalAttempts);
    for (const worker of initial.workers) {
      const result = signalIdleWorker(root, worker, 'SIGTERM', diagnostic, signalAttempts);
      if (result === null) return restartRefused(root, request, diagnostic, signalAttempts);
      if (result) signaled.push(worker.pid);
    }
    if (signaled.length) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    for (const worker of initial.workers) {
      const result = signalIdleWorker(root, worker, 'SIGKILL', diagnostic, signalAttempts);
      if (result === null) return restartRefused(root, request, diagnostic, signalAttempts);
      if (result && !signaled.includes(worker.pid)) signaled.push(worker.pid);
    }
    const reply = runnerIdleReply(root, request, processCensus);
    if (!reply.idle) return restartRefused(root, request, { reason: reply.reason }, signalAttempts);
    process.stdout.write(JSON.stringify({ ...reply, restarted: signaled, signalAttempts }) + '\n');
  } catch (error) {
    if (request === undefined) process.exitCode = 1;
    restartRefused(root, request, { reason: 'restart observation failed' + (error.code ? ' [' + error.code + ']' : '') + ': ' + error.message }, signalAttempts);
  }
}
