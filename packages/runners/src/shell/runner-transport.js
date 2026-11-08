/** Bounded transport health observations never execute or certify a project's tests [C7]. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { recoveryIdentity } from '../../../resources/index.js';
import { openPoolReadOnly } from '../../../resources/index.js';
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
import { spawnSsh } from '../../../transport/index.js';
import { guiSession } from '../../../gate/src/shell/gui-session.js';
import { parseProcessCensus } from '../../../kernel/src/core/process-census.js';

/** Give a health observation the same credential-forwarding limits as a worker connection. */
function environment() {
  const env = { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'TMPDIR', 'SystemRoot', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** Quote one configured executable without interpreting its contents as remote shell code. */
function word(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

/**
 * Confirm SSH and the configured Node answer a fresh nonce; this does not attest worker cleanup or test success.
 * `timeoutMs` bounds the whole observation (default 3 s); a confirming probe after a failed call passes a longer
 * budget so a loaded runner is not mistaken for a dead one [C7].
 */
export async function probeRunnerTransport(runner, { observeGui = false, observeLoad = false, discoverNode = false, enrollSigningKey = false, timeoutMs = 3_000 } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@:\[\]-]{0,254}$/u.test(runner?.host ?? '')
    || runner.node !== undefined && (typeof runner.node !== 'string' || /[\u0000-\u001f\u007f]/u.test(runner.node)
      || !(runner.node === 'node' || runner.node.startsWith('/')))) {
    return { healthy: false, reason: 'invalid runner destination' };
  }
  const nonce = randomUUID();
  const desktop = observeGui || observeLoad || enrollSigningKey ? `/* pullboard registration GUI probe */const {spawnSync}=require('node:child_process');const guiSession=${guiSession.toString()};const os=require('node:os');` : '';
  const signing = enrollSigningKey ? `const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const signingHome=process.env.PULLBOARD_MACHINE_HOME||path.join(process.env.HOME||os.homedir(),'.pullboard');if(!path.isAbsolute(signingHome))throw new Error('runner signing home must be absolute');fs.mkdirSync(signingHome,{recursive:true,mode:0o700});fs.chmodSync(signingHome,0o700);const pair=crypto.generateKeyPairSync('ed25519');const der=pair.publicKey.export({type:'spki',format:'der'});const enrolledPublicKey=der.toString('base64url');const keyId=crypto.createHash('sha256').update(der).digest('hex');const keyPath=path.join(signingHome,'runner-signing-'+keyId+'.pem');const temporary=keyPath+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temporary,pair.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});fs.renameSync(temporary,keyPath);fs.chmodSync(keyPath,0o600);}finally{fs.rmSync(temporary,{force:true});}` : '';
  const answer = `process.stdout.write(JSON.stringify({nonce:${JSON.stringify(nonce)},node:process.versions.node${discoverNode ? ',nodePath:process.execPath' : ''}${observeGui ? ',gui:guiSession(),cores:os.availableParallelism(),memoryMB:Math.floor(os.totalmem()/1048576)' : ''}${observeLoad ? ',cpuLoad:{at:new Date().toISOString(),busyPercent:busy,average:os.loadavg()}' : ''}${enrollSigningKey ? ',publicKey:enrolledPublicKey' : ''}}))`;
  // Both snapshots run on the destination; controller CPU counters never stand in for a runner.
  const script = observeLoad ? `${desktop}${signing}const first=os.cpus();setTimeout(()=>{const last=os.cpus();let idle=0,total=0;for(let i=0;i<last.length;i++){if(!first[i])continue;for(const key of Object.keys(last[i].times)){const delta=last[i].times[key]-first[i].times[key];total+=delta;if(key==='idle')idle+=delta;}}const busy=total>0?100*(1-idle/total):null;${answer}},100);` : `${desktop}${signing}${answer}`;
  const command = `${word(runner.node ?? 'node')}${observeGui || observeLoad ? ' --input-type=commonjs' : ''} -e ${word(script)}`;
  const remote = discoverNode ? 'exec "${SHELL:-/bin/sh}" -lc ' + word(command) : command;
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'SendEnv=-*', '-o', `ConnectTimeout=${Math.max(2, Math.floor(timeoutMs / 1_000) - 1)}`, '--', runner.host, remote];
  const child = spawnSsh(args, { env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', error = null, timedOut = false, kill;
  /** Keep a misbehaving transport bounded without changing any native execution budget. */
  const stop = () => {
    child.kill('SIGTERM');
    kill ??= setTimeout(() => child.kill('SIGKILL'), 500);
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(0, 4097); if (stdout.length > 4096) stop(); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
  child.once('error', failure => { error = failure.code ?? failure.name; });
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); clearTimeout(kill);
  let reply;
  try { reply = JSON.parse(stdout); } catch { /* A missing or foreign answer is unknown health. */ }
  const version = /^(\d+)\.(\d+)\./u.exec(reply?.node ?? '');
  const healthy = !error && !timedOut && result.code === 0 && !result.signal && reply?.nonce === nonce
    && version && (Number(version[1]) > 22 || Number(version[1]) === 22 && Number(version[2]) >= 13)
    && (!enrollSigningKey || typeof reply?.publicKey === 'string' && /^[A-Za-z0-9_-]{59}$/u.test(reply.publicKey));
  const cpu = reply?.cpuLoad;
  const measured = cpu && Number.isFinite(Date.parse(cpu.at)) && Number.isFinite(cpu.busyPercent) && cpu.busyPercent >= 0 && cpu.busyPercent <= 100
    && Array.isArray(cpu.average) && cpu.average.length === 3 && cpu.average.every(n => Number.isFinite(n) && n >= 0);
  // Arbitrary stderr is deliberately not returned by a health-only probe; the failed job retains its sanitized diagnostics.
  return { healthy: Boolean(healthy), ...(healthy && discoverNode && typeof reply?.nodePath === 'string' && isAbsolute(reply.nodePath) && !/[\u0000-\u001f\u007f]/u.test(reply.nodePath) ? { nodePath: reply.nodePath } : {}), ...(healthy && enrollSigningKey ? { publicKey: reply.publicKey } : {}), ...(healthy && observeLoad && measured ? { cpuLoad: cpu } : {}), ...(observeGui ? { gui: healthy && typeof reply?.gui === 'boolean' ? reply.gui : null,
    ...(healthy && Number.isSafeInteger(reply?.cores) && reply.cores > 0 && Number.isSafeInteger(reply?.memoryMB) && reply.memoryMB > 0 ? { cores: reply.cores, memoryMB: reply.memoryMB } : {}) } : {}), command: ['ssh', ...args.slice(0, -1), `${runner.node ?? 'node'} [nonce health observation]`],
    ...result, error, timedOut, stderrBytes: Buffer.byteLength(stderr), reason: healthy ? 'configured Node answered nonce' : 'transport health not confirmed' };
}

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
export function runnerWorkerMatcher(root, { exactEntrypoint = false } = {}) {
  const canonicalRoot = realpathSync(root);
  const roots = [...new Set([root, canonicalRoot])].map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const source = '(?:' + roots.join('|') + ')/runtime/[a-f0-9]{64}/src/runner-worker\\.js';
  if (exactEntrypoint) {
    const entry = new RegExp('^' + source + '$', 'u');
    /** A positive entrypoint proof matches the complete argv path, never the conservative busy substring. */
    return command => entry.exec(command)?.[0] === command;
  }
  const entry = new RegExp('(?:^|\\s|["\'])' + source + '(?=\\s|$)', 'u');
  /** Keep selection and the canonical idle guard on the same exact worker predicate. */
  return command => {
    const worker = entry.exec(command);
    return Boolean(worker && !/^\s+--health(?:\s|$)/u.test(command.slice(worker.index + worker[0].length)));
  };
}

/** Observe live owners and job working directories; restart may exclude only exact census-bound worker identities from the worker-presence check. */
export function runnerProcessesIdle(root, diagnostic, { ignoredWorkers = [] } = {}) {
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
    if (isWorker(row[2]) && !ignored.has(actual.pid)) { diagnostic.pid = actual.pid; return false; }
  }
  const jobs = join(canonicalRoot, 'jobs');
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
      if (actual && !actual.state.startsWith('Z') && actual.started === owner.started) { diagnostic.pid = actual.pid; return false; }
    } catch (error) { if (error.code !== 'ENOENT') return false; }
  }
  /** Compare directory components so jobs-old never counts as a running job. */
  const inJobs = path => {
    const part = relative(jobs, path);
    return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
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
export function runnerIdleReply(root, request, processCensus) {
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
    if (resourceFile) {
      if (!resourceFile.isFile()) return { ...base, reason: 'runner resource location is not a file' };
      const db = openPoolReadOnly(file, 1_000);
      try {
        // A holder whose process is gone is a leak the machine reclaims on its next write; it must not keep the
        // runner "busy" forever, which idled the largest runner for a day on three dead pids [C7].
        // Every column, since an older or minimal holder table may lack pid; a holder without one still counts as active.
        const holders = db.prepare("SELECT * FROM holder WHERE name='gate' OR agent LIKE 'pullboard-ssh-%'").all();
        if (holders.some(holder => holderProcessAlive(holder.pid))) return { ...base, reason: 'runner resource lease is active' };
      } finally { db.close(); }
    }
    const marker = join(root, `.idle-probe-${request.nonce}`);
    writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
    unlinkSync(marker);
    try { jobDirectory = lstatSync(jobs); }
    catch (error) { if (error.code !== 'ENOENT') throw error; jobDirectory = null; }
    const diagnostic = {};
    if (jobDirectory && !jobDirectory.isDirectory() || !runnerProcessesIdle(root, diagnostic))
      return { ...base, reason: Number.isSafeInteger(diagnostic.pid)
        ? `runner process or job working directory remains: pid ${diagnostic.pid}`
        : 'runner process or job working directory appeared or could not be verified' };
    return { ...base, idle: true, writable: true, reason: 'no live runner process, job working directory or resource lease and runner root writable' };
  } catch { return { ...base, reason: 'runner idle or writable state could not be verified' }; }
}
