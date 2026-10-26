/** SSH runner entry point in a pinned capsule with a static trusted resource graph. */
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import {
  captureTestRuntimes,
  executionEnvironment,
} from './execution-environment.js';
import { sampleRunnerLoad } from './runner-load.js';
import { freemem } from 'node:os';
import { loadavg } from 'node:os';
import { userInfo } from 'node:os';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import * as resourceApi from './resources.js';
import { createDescendantTracker } from './runner-custody.js';
import { Refused } from './refused.js';
import { guiSession } from './gui-session.js';
import { privateCheckEnvelope } from './runner-private-mode.js';
import {
  gateStages,
  stagedScript,
  readPipes,
} from './gate-stages.js';
import { fileDenialWatcher } from './sandbox-denial.js';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';

const RECEIPT = 'PULLBOARD_RUNNER_RESULT';
const safePath = [dirname(process.execPath), process.env.PATH || '/usr/local/bin:/usr/bin:/bin'].join(delimiter);
const ownedChildren = new Map();
let transportLost = false;
let transportDrain = null;
let signalCustodyInstalled = false;
let transportDrop = () => {};
let markTransportGone;
// Settles when the transport is lost, so a write waiting on a dead stdout stops waiting (#888).
const transportGone = new Promise(resolveGone => { markTransportGone = resolveGone; });
let heartbeatTimer = null;
let workerId = 'starting';
let rejectPendingFrame = null;
let activeDescendantTracker = null;
// Budget: report a named failure within 30 seconds after command exit or transport cancellation.
const CLEANUP_BUDGET_MS = 30_000;
let cleanupDeadline = Infinity;
let phaseCleanupDeadline = Infinity;
let phaseCleanupTimer = null;
let cleanupTimedOut = false;
let cleanupTimer = null;
let cleanupStage = 'command exit';
let cleanupDirectory = null;
let cleanupDetails = null;
const setupPrivatePaths = new Set();

/** Start the post-run budget once; later cleanup phases cannot extend it. */
function beginCleanup() {
  if (Number.isFinite(cleanupDeadline)) return;
  cleanupDeadline = Math.min(cleanupDeadline, Date.now() + CLEANUP_BUDGET_MS);
  cleanupTimer = setTimeout(reportCleanupTimeout, CLEANUP_BUDGET_MS);
  cleanupTimer.unref();
}

/** Bound an intermediate install drain without starting or extending the final/disconnect budget. */
function beginPhaseCleanup() {
  if (Number.isFinite(phaseCleanupDeadline)) return;
  phaseCleanupDeadline = Date.now() + CLEANUP_BUDGET_MS;
  phaseCleanupTimer = setTimeout(reportCleanupTimeout, CLEANUP_BUDGET_MS);
  phaseCleanupTimer.unref();
}

/** A fully verified successful intermediate drain is the only boundary allowed to clear its own timer. */
function clearPhaseCleanup() {
  if (Date.now() >= Math.min(cleanupDeadline, phaseCleanupDeadline)) {
    reportCleanupTimeout();
    return false;
  }
  if (transportLost || cleanupTimedOut || Number.isFinite(cleanupDeadline) || ownedChildren.size) return false;
  clearTimeout(phaseCleanupTimer);
  phaseCleanupTimer = null;
  phaseCleanupDeadline = Infinity;
  return true;
}

/** Report an unresolved cleanup once so the controller can fail without retrying the command. */
function reportCleanupTimeout() {
  if (cleanupTimedOut || Date.now() < Math.min(cleanupDeadline, phaseCleanupDeadline)) return;
  cleanupTimedOut = true;
  const details = { id: workerId, stage: cleanupStage, ...(cleanupDetails?.() ?? {}) };
  // A timeout may arrive after ordinary job deletion while output is still flushing.
  // Keep a small diagnostic even then; it never contains command arguments or credentials.
  if (cleanupDirectory) {
    try {
      mkdirSync(cleanupDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(cleanupDirectory, 'cleanup-timeout.json'), JSON.stringify(details) + '\n', { mode: 0o600 });
    } catch { /* The named red result remains authoritative if diagnostic storage fails. */ }
  }
  process.stderr.write(`PULLBOARD_RUNNER_CLEANUP_UNVERIFIED ${workerId} ${details.reason || cleanupStage}\n`);
  process.stderr.write(`PULLBOARD_RUNNER_CLEANUP_TIMEOUT ${workerId}\n`);
}

/** Retry a drained holder's real deletion instead of abandoning its row after a transient write failure. */
async function releaseDrainedLease(lease) {
  let reported = false;
  for (;;) {
    try { lease.release(); return; }
    catch {
      reportCleanupTimeout();
      if (!reported) {
        // Parent death can close the transport before stderr arrives; retain this real failed attempt in the private job.
        if (cleanupDirectory) {
          try {
            const pending = join(cleanupDirectory, 'release-pending.json');
            const temporary = pending + '.tmp';
            writeFileSync(temporary,
              JSON.stringify({ id: workerId, stage: 'lease release', pending: true, observedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
            renameSync(temporary, pending);
          }
          catch { /* The live retry and named cleanup timeout remain authoritative if diagnostic storage fails. */ }
        }
        process.stderr.write(`PULLBOARD_RUNNER_RELEASE_PENDING ${workerId}\n`);
        reported = true;
      }
      // The lease and its database stay open until deletion commits; the normal cleanup budget reports a persistent failure.
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

/** Parse and strictly validate the controller's one-shot work specification. */
async function readSpec() {
  let buffered = Buffer.alloc(0);
  let expected = null;
  let headerLength = null;
  const spec = await new Promise((resolve, reject) => {
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.off('error', onError); };
    rejectPendingFrame = error => { cleanup(); reject(error); };
    const onError = error => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new Error('incomplete work specification')); };
    const onData = chunk => {
      if (transportLost) { cleanup(); reject(new Error('runner transport was lost')); return; }
      buffered = Buffer.concat([buffered, chunk]);
      if (expected === null) {
        const newline = buffered.indexOf(10);
        if (newline < 0) {
          if (buffered.length > 9 || !/^\d*$/u.test(buffered.toString('ascii'))) { cleanup(); reject(new Error('invalid work specification frame')); }
          return;
        }
        const header = buffered.subarray(0, newline).toString('ascii');
        if (!/^\d{1,8}$/u.test(header)) { cleanup(); reject(new Error('invalid work specification frame')); return; }
        expected = Number(header);
        headerLength = newline + 1;
        if (!expected || expected > 1_048_576) { cleanup(); reject(new Error('invalid work specification frame')); return; }
      }
      if (buffered.length < headerLength + expected) return;
      const body = buffered.subarray(headerLength, headerLength + expected);
      const rest = buffered.subarray(headerLength + expected);
      cleanup();
      rejectPendingFrame = null;
      process.stdin.pause();
      if (rest.length) process.stdin.unshift(rest);
      try { resolve(JSON.parse(body.toString('utf8'))); } catch (error) { reject(error); }
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
  const value = spec;
  if (!value || value.version !== 1 || !/^[A-Za-z0-9_-]{1,100}$/u.test(value.id)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.commit)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.tree)
    || value.commit.length !== value.tree.length
    || !/^[a-f0-9]{64}$/u.test(value.repoId ?? '')
    || typeof value.command !== 'string' || !value.command.trim()
    || typeof value.pipefail !== 'boolean' || !Number.isSafeInteger(value.slots) || value.slots < 1
    || !Number.isSafeInteger(value.browser) || value.browser < 0
    || typeof value.browserRequired !== 'boolean'
    || value.guiRequired !== undefined && typeof value.guiRequired !== 'boolean'
    || (value.timing !== undefined && typeof value.timing !== 'boolean')
    || (value.browserByLaunch !== undefined && typeof value.browserByLaunch !== 'boolean')
    || !value.runtime || typeof value.runtime !== 'object' || !value.runtime.files || typeof value.runtime.files !== 'object'
    || typeof value.runtime.sha256 !== 'string') throw new Error('invalid work specification');
  if (value.trustedMode !== undefined) {
    const mode = privateCheckEnvelope(value.trustedMode);
    if (mode.policyCommit.length !== value.commit.length || value.command !== mode.check || value.landing === true || value.stageMarker !== undefined) throw new Error('invalid trusted private-check source');
    value.trustedMode = mode;
  }
  if (value.timeoutMs !== undefined && (value.landing !== true || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 2_147_483_647)) throw new Error('invalid landing timeout');
  if (value.stageMarker !== undefined && !/^PULLBOARD_STAGE_[a-f0-9]{32}$/u.test(value.stageMarker)) throw new Error('invalid stage marker');
  if (value.waivers !== undefined && (!Array.isArray(value.waivers) || value.waivers.some(entry => !entry || !['file', 'name'].includes(entry.kind) || typeof entry.test !== 'string' || !entry.test || Object.keys(entry).some(key => !['kind', 'test'].includes(key))))) throw new Error('invalid continuation projection');
  if (value.origin !== undefined) {
    if (typeof value.origin !== 'string') throw new Error('invalid work specification');
    let origin;
    try { origin = new URL(value.origin); } catch { throw new Error('invalid work specification'); }
    if (origin.protocol !== 'https:' || !origin.hostname || origin.username || origin.password || origin.search || origin.hash) {
      throw new Error('invalid work specification');
    }
  }
  if (value.originBase !== undefined
    && (typeof value.originBase !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.originBase)
      || value.originBase.length !== value.commit.length || !value.origin)) throw new Error('invalid work specification');
  if (!Array.isArray(value.tags) || value.tags.length > 1_024) throw new Error('invalid tag manifest');
  const tagNames = new Set();
  for (const tag of value.tags) {
    if (!tag || typeof tag.name !== 'string' || !tag.name.startsWith('refs/tags/') || tag.name.length > 1_024
      || /[\u0000-\u001f\u007f]/u.test(tag.name) || tagNames.has(tag.name)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tag.object ?? '')
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tag.peeledCommit ?? '')
      || tag.object.length !== value.commit.length || tag.peeledCommit.length !== value.commit.length
      || !Array.isArray(tag.chain) || tag.chain.length > 8
      || tag.chain.some(object => typeof object !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(object)
        || object.length !== value.commit.length)) throw new Error('invalid tag manifest');
    tagNames.add(tag.name);
    if (tag.chain.length ? tag.chain[0] !== tag.object : tag.object !== tag.peeledCommit) throw new Error('invalid tag manifest');
  }
  const runtimeNames = ['runner-custody.js', 'resources.js', 'runner-wait.js', 'git.js', 'machine-home.js', 'refused.js', 'process-census.js', 'queue-settings.js', 'queue-order.js', 'sandbox-denial.js', 'gate-stages.js', 'child-journal-preload.js', 'execution-environment.js', 'runner-load.js', 'gui-session.js', 'runner-private-mode.js'];
  if (Object.keys(value.runtime.files).length !== runtimeNames.length
    || runtimeNames.some(name => typeof value.runtime.files[name] !== 'string')) throw new Error('invalid work specification');
  if (createHash('sha256').update(JSON.stringify(value.runtime.files)).digest('hex') !== value.runtime.sha256) throw new Error('invalid trusted runtime');
  const workerSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const toolingFiles = { ...value.runtime.files, 'runner-worker.js': workerSource };
  if (!workerSource || !value.tooling || !['git-checkout', 'installed-package'].includes(value.tooling.kind)
    || value.tooling.name !== 'pullboard' || typeof value.tooling.version !== 'string'
    || createHash('sha256').update(JSON.stringify(toolingFiles)).digest('hex') !== value.tooling.sha256) {
    throw new Error('invalid trusted tooling identity');
  }
  for (const field of ['landing', 'itemCheck', 'diagnostic']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new Error('invalid work specification');
  }
  for (const field of ['item', 'kind']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') throw new Error('invalid work specification');
  }
  if (value.root !== undefined && (typeof value.root !== 'string' || !isAbsolute(value.root))) throw new Error('invalid work specification');
  return value;
}

/** Construct a minimal environment from runner-owned values, excluding caller credentials and markers. */
function childEnvironment(home, temporary, machineHomePath = '', nodeOptions = '') {
  return {
    PATH: safePath,
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    LANG: process.env.LANG || 'C.UTF-8',
    TZ: process.env.TZ || 'UTC',
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    NPM_CONFIG_USERCONFIG: join(home, 'npm-userconfig'),
    NPM_CONFIG_GLOBALCONFIG: join(home, 'npm-globalconfig'),
    // The spawn-journal preload is declared so a test's NODE_OPTIONS classifier knows it is the runner's own.
    ...(nodeOptions ? { NODE_OPTIONS: nodeOptions, PULLBOARD_RUNNER_PRELOAD: nodeOptions } : {}),
    ...(machineHomePath ? { PULLBOARD_MACHINE_HOME: machineHomePath } : {}),
  };
}

/** Add this worker's remote gate lease so nested test runners reuse the remote slot instead of deadlocking. */
function scopedEnvironment(home, temporary, machineHomePath, gateLease, resourcesApi, nodeOptions = '') {
  return {
    ...childEnvironment(home, temporary, machineHomePath, nodeOptions),
    ...resourcesApi.gateSlotEnvironment(gateLease),
  };
}

/** Check that this already installed capsule matches the controller before using its static API. */
function loadResourceApi(runtime) {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  if (Object.entries(runtime.files).some(([name, source]) => readFileSync(join(sourceDirectory, name), 'utf8') !== source)) {
    throw new Error('trusted runtime cache does not match the request');
  }
  return resourceApi;
}

/** Start a subprocess in a private process group so this worker can drain only its own descendants. */
function spawnOwned(command, args, options = {}) {
  assertTransportLive();
  const child = spawn(command, args, { ...options, detached: true });
  let settle;
  const closed = new Promise(resolveClose => { settle = resolveClose; });
  const record = { child, pid: child.pid, closed, drainPromise: null };
  ownedChildren.set(child, record);
  activeDescendantTracker?.registerRoot(child.pid);
  child.once('error', error => settle({ error }));
  child.once('close', (code, signal) => settle({ code, signal }));
  return record;
}


/** Stop and fully drain one owned process group before its gate lease can be released. */
function drainOwned(record, terminate = false, tracker = activeDescendantTracker) {
  if (!record) return Promise.resolve();
  record.drainPromise ??= (async () => {
    if (terminate) await stopOwnedGroup(record.pid, record.closed, tracker);
    else {
      await record.closed;
      await stopOwnedGroup(record.pid, record.closed, tracker);
    }
    ownedChildren.delete(record.child);
  })();
  return record.drainPromise;
}

/** Install disconnect custody before receiving the pack or starting any setup subprocess. */
function installSignalCustody() {
  if (signalCustodyInstalled) return;
  signalCustodyInstalled = true;
  const disconnected = () => {
    if (transportLost) return;
    transportLost = true;
    markTransportGone();
    beginCleanup();
    rejectPendingFrame?.(new Error('runner transport was lost'));
    clearInterval(heartbeatTimer);
    const active = [...ownedChildren.values()];
    transportDrain = (async () => {
      await activeDescendantTracker?.stopDescendants();
      await Promise.all(active.map(record => drainOwned(record, true)));
      await activeDescendantTracker?.verifyAfterGroups();
    })();
    transportDrain.catch(() => {});
  };
  transportDrop = disconnected;
  process.on('SIGHUP', disconnected);
  process.on('SIGTERM', disconnected);
  process.stdin.on('error', disconnected);
  process.stdout.on('error', disconnected);
  process.stderr.on('error', disconnected);
  let heartbeatPending = false;
  heartbeatTimer = setInterval(() => {
    if (transportLost || heartbeatPending) return;
    heartbeatPending = true;
    process.stderr.write(`PULLBOARD_RUNNER_HEARTBEAT ${workerId}\n`, error => {
      heartbeatPending = false;
      if (error) disconnected();
    });
  }, 5_000);
  heartbeatTimer.unref();
}

/** Stop queue/setup work promptly after the controller's transport disappears. */
function assertTransportLive() {
  if (transportLost) throw new Error('runner transport was lost');
}

/** Wait for every owned group, terminating any still present after its leader exits. */
async function drainAllOwned() {
  await Promise.all([...ownedChildren.values()].map(record => drainOwned(record, transportLost)));
  if (transportDrain) await transportDrain;
}

/** Select only the explicit pool while acquiring its lease; restore the worker environment afterward. */
async function acquireResourceApi(api, options, machineHomePath) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHomePath;
  try { return await api.takeResource(options); }
  finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}

/**
 * Size this machine's gate and browser pools to the capacity the controller registered, carried in
 * the job (#1066). A lower registration waits for an idle pool, and is refused by name until then.
 */
function registeredCapacity(api, spec, root, machineHomePath) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHomePath;
  try {
    /** Set one pool row; a busy pool cannot shrink, so this run is refused rather than oversubscribed. */
    const size = (name, capacity) => {
      try { return api.setResourceCapacity({ name, capacity, scope: 'machine', root }).capacity; }
      catch (error) {
        if (error?.code !== 'RESOURCE_BUSY') throw error;
        throw new Refused('RUNNER_CAPACITY_BUSY', `this runner is registered with ${capacity} ${name} slot(s), fewer than its busy pool holds; it shrinks once its running jobs end`);
      }
    };
    // A runner registered with no browsers never receives a browser run, so its browser row is left alone.
    return { gateCapacity: size('gate', spec.slots), browserCapacity: spec.browser > 0 ? size('browser', spec.browser) : 1 };
  } finally {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  }
}

/** Bound Git diagnostics and hide runner-private paths, URL credentials and credential assignments. */
function safeGitDiagnostic(value, root, env) {
  let text = String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  for (const [path, label] of [[root, '<source>'], [env.HOME, '<job-home>'], [process.env.HOME, '<runner-home>'], [env.TMPDIR, '<job-tmp>'], ...[...setupPrivatePaths].map(path => [path, '<runner-state>'])]) {
    if (path && path.length > 1) text = text.split(path).join(label);
  }
  text = text.replace(/https?:\/\/[^\s"'<>]+/giu, '<url>')
    .replace(/\b(authorization|cookie)\s*[:=][ \t]*[^\n]+/giu, '$1=<redacted>')
    .replace(/\b(authorization|cookie|token|secret|password|api[_-]?key|access[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;]+)/giu, '$1=<redacted>')
    .replace(/\b(?:gh[pousr]_|github_pat_|ps_|pa_|pm_|pg_|sk-)[A-Za-z0-9_-]{8,}/gu, '<redacted>')
    .replace(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/gu, '<private-address>').trim();
  const bytes = Buffer.from(text);
  return bytes.length > 2_048 ? `${bytes.subarray(0, 768).toString('utf8')}\n...[truncated]...\n${bytes.subarray(-1_024).toString('utf8')}` : text;
}

/** Keep the failed Git operation and bounded cause without exposing command arguments or raw errors. */
function gitSetupFailure(root, args, env, result, stderr, overflow, inputError) {
  const commands = new Set(['init', 'fetch', 'checkout', 'index-pack', 'cat-file', 'rev-parse', 'rev-list', 'for-each-ref', 'update-ref', 'merge-base', 'verify-pack', 'check-ref-format']);
  const operation = args.find(arg => commands.has(arg)) ?? 'command';
  const role = root.endsWith('.git') || args.includes('--bare') ? 'source cache' : 'source checkout';
  const code = result.error?.code ?? inputError?.code;
  const status = overflow ? 'stdout limit exceeded' : result.error && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code ?? '') ? code
    : Number.isInteger(result.code) && result.code !== 0 ? `exit ${result.code}`
    : result.signal ? `signal ${result.signal}` : /^[A-Z][A-Z0-9_]{0,63}$/u.test(code ?? '') ? code : 'input failed';
  const error = new Error('source checkout could not be verified');
  error.runnerSetup = { step: `${role}: git ${operation}`, status, stderr: safeGitDiagnostic(stderr, root, env) };
  return error;
}

/** Invoke bounded Git in an owned group, retaining stderr if it fails instead of erasing the cause. */
async function git(root, args, env, input) {
  const owned = spawnOwned('git', args, { cwd: root, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const output = [];
  let stderr = Buffer.alloc(0);
  owned.child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(-8_192); });
  let bytes = 0;
  let overflow = false;
  let inputError;
  let inputDone;
  if (input !== undefined) {
    owned.child.stdin.on('error', error => { inputError ??= error; });
    if (typeof input.pipe === 'function') inputDone = pipeline(input, owned.child.stdin).catch(error => { inputError ??= error; });
    else owned.child.stdin.end(input);
  }
  owned.child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 128 * 1024 * 1024) {
      if (!overflow) { overflow = true; drainOwned(owned, true).catch(() => {}); }
    } else if (!overflow) output.push(chunk);
  });
  const result = await owned.closed;
  await inputDone;
  await drainOwned(owned);
  if (overflow || inputError || result.error || result.code !== 0 || result.signal) throw gitSetupFailure(root, args, env, result, stderr.toString('utf8'), overflow, inputError);
  return Buffer.concat(output).toString('utf8').trim();
}

/** Receive the negotiated history pack after the worker announces the cache's candidate tips. */
async function receivePack(packFile) {
  await pipeline(process.stdin, createWriteStream(packFile, { mode: 0o600, flags: 'wx' }));
}

/** Receive only missing ancestry, validate the full graph, then copy the exact commit into a clean job repository. */
async function checkoutHistory(api, runnerRoot, root, packFile, spec, env) {
  const repositories = join(runnerRoot, 'repos');
  mkdirSync(repositories, { recursive: true, mode: 0o700 });
  chmodSync(repositories, 0o700);
  const cache = join(repositories, `${spec.repoId}.git`);
  const cacheLease = await acquireResourceApi(api, {
    name: `repo-${spec.repoId}`, capacity: 1, scope: 'machine', root: runnerRoot,
    repo: runnerRoot, agent: `pullboard-ssh-cache-${spec.id}`, kind: 'source-cache',
    onWait: () => assertTransportLive(),
  }, join(runnerRoot, 'cache', 'resource-pool')).catch(error => {
    if (error && typeof error === 'object') error.runnerSetupStep = 'source cache admission';
    throw error;
  });
  const deliveryRefs = [];
  try {
    if (!existsSync(cache)) {
      const build = mkdtempSync(join(repositories, `.repo-${spec.repoId}-`));
      const staged = join(build, 'cache.git');
      try {
        const initialize = async () => {
          await git(build, ['init', '--bare', `--object-format=${spec.commit.length === 64 ? 'sha256' : 'sha1'}`, staged], env);
        };
        await initialize();
        if (spec.origin && spec.originBase) {
          let seeded = false;
          try {
            await git(staged, ['-c', 'protocol.version=2', 'fetch', '--no-tags', '--no-recurse-submodules', spec.origin, spec.originBase], env);
            seeded = await git(staged, ['cat-file', '-t', spec.originBase], env) === 'commit'
              && Number(await git(staged, ['rev-list', '--count', spec.originBase], env)) > 0
              && !existsSync(join(staged, 'shallow'));
            if (seeded) await git(staged, ['update-ref', `refs/pullboard/published/${spec.originBase}`, spec.originBase], env);
          } catch { seeded = false; }
          if (!seeded) {
            rmSync(staged, { recursive: true, force: true });
            await initialize();
          }
        }
        renameSync(staged, cache);
      } finally { rmSync(build, { recursive: true, force: true }); }
    }
    if (await git(cache, ['rev-parse', '--is-bare-repository'], env) !== 'true'
      || await git(cache, ['rev-parse', '--show-object-format'], env) !== (spec.commit.length === 64 ? 'sha256' : 'sha1')
      || existsSync(join(cache, 'shallow')) || existsSync(join(cache, 'objects', 'info', 'alternates'))) {
      throw new Error('source history cache has an incompatible format');
    }
    const refLines = await git(cache, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/pullboard/candidates', 'refs/pullboard/published'], env);
    const tips = [];
    if (refLines) for (const line of refLines.split(/\r?\n/u)) {
      const split = /^(refs\/pullboard\/(?:candidates|published)\/.+) ([a-f0-9]{40,64})$/u.exec(line);
      if (!split || split[2].length !== spec.commit.length) {
        throw new Error('source history cache contains an invalid candidate ref');
      }
      if (split[1].slice(split[1].lastIndexOf('/') + 1) !== split[2]) {
        throw new Error('source history cache contains an invalid candidate ref');
      }
      if (await git(cache, ['cat-file', '-t', split[2]], env) !== 'commit') {
        throw new Error('source history cache contains a non-commit tip');
      }
      tips.push(split[2]);
    }
    const uniqueTips = [...new Set(tips)];
    if (uniqueTips.length > 1_024) throw new Error('source history cache needs maintenance');
    const requestedTagObjects = [...new Set(spec.tags.flatMap(tag => tag.chain))];
    const knownTagObjects = [];
    if (requestedTagObjects.length) {
      const checks = await git(cache, ['cat-file', '--batch-check'], env, `${requestedTagObjects.join('\n')}\n`);
      const lines = checks.split(/\r?\n/u).filter(Boolean);
      if (lines.length !== requestedTagObjects.length) throw new Error('source tag inventory is incomplete');
      for (let index = 0; index < lines.length; index++) {
        const match = /^([a-f0-9]{40,64}) tag \d+$/u.exec(lines[index]);
        if (match && match[1] === requestedTagObjects[index]) knownTagObjects.push(match[1]);
        else if (!new RegExp(`^${requestedTagObjects[index]} missing$`, 'u').test(lines[index])) {
          throw new Error('source tag inventory contains an invalid object');
        }
      }
    }
    await new Promise((resolveWrite, rejectWrite) => process.stderr.write(
      `PULLBOARD_RUNNER_NEED ${spec.id} ${Buffer.from(JSON.stringify({ tips: uniqueTips, tagObjects: knownTagObjects })).toString('base64')}\n`,
      error => error ? rejectWrite(error) : resolveWrite()));
    await receivePack(packFile);

    const priorIndexes = new Set(readdirSync(join(cache, 'objects', 'pack')).filter(name => name.endsWith('.idx')));
    if (statSync(packFile).size < 12 + spec.commit.length / 2) throw new Error('source history pack is incomplete');
    await git(cache, ['index-pack', '--stdin'], env, createReadStream(packFile));
    const objectType = await git(cache, ['cat-file', '-t', spec.commit], env);
    if (objectType !== 'commit' || await git(cache, ['rev-parse', `${spec.commit}^{tree}`], env) !== spec.tree) {
      throw new Error('source history does not match the requested commit and tree');
    }
    const historyCount = Number(await git(cache, ['rev-list', '--count', spec.commit], env));
    if (!Number.isSafeInteger(historyCount) || historyCount < 1) throw new Error('source history is incomplete');
    if (spec.originBase) await git(cache, ['merge-base', '--is-ancestor', spec.originBase, spec.commit], env);
    const roots = [...new Set([spec.commit, ...(spec.trustedMode ? [spec.trustedMode.policyCommit, spec.trustedMode.trunk.commit] : [])])];
    for (const commit of roots) {
      if (await git(cache, ['cat-file', '-t', commit], env) !== 'commit') throw new Error('trusted policy history is incomplete');
    }
    const closure = new Set((await git(cache, ['rev-list', '--objects', ...roots], env)).split(/\r?\n/u)
      .map(line => line.match(/^([a-f0-9]{40,64})(?:\s|$)/u)?.[1]).filter(Boolean));
    closure.add(spec.commit);
    const tagObjects = new Set(spec.tags.flatMap(tag => tag.chain));
    const packDirectory = join(cache, 'objects', 'pack');
    const newIndexes = readdirSync(packDirectory).filter(name => name.endsWith('.idx') && !priorIndexes.has(name));
    const received = new Set();
    for (const indexName of newIndexes) {
      for (const line of (await git(cache, ['verify-pack', '-v', join(packDirectory, indexName)], env)).split(/\r?\n/u)) {
        const object = line.match(/^([a-f0-9]{40,64})\s+(?:commit|tree|blob|tag)\s/u)?.[1];
        if (object) received.add(object);
      }
    }
    if ([...received].some(object => !closure.has(object) && !tagObjects.has(object))) {
      throw new Error('source history pack contains missing or unrelated objects');
    }
    for (const tag of spec.tags) {
      await git(cache, ['check-ref-format', tag.name], env);
      if (tag.chain.length) {
        let target = tag.object;
        for (let index = 0; index < tag.chain.length; index++) {
          const object = tag.chain[index];
          if (target !== object || (!received.has(object) && !knownTagObjects.includes(object))
            || await git(cache, ['cat-file', '-t', object], env) !== 'tag') {
            throw new Error('source tag chain is incomplete or unrelated');
          }
          const body = await git(cache, ['cat-file', '-p', object], env);
          const header = body.split(/\r?\n\r?\n/u, 1)[0];
          const next = /^object ([a-f0-9]{40,64})$/mu.exec(header)?.[1];
          const type = /^type (commit|tag|tree|blob)$/mu.exec(header)?.[1];
          const expectedNext = tag.chain[index + 1] ?? tag.peeledCommit;
          const expectedType = index + 1 < tag.chain.length ? 'tag' : 'commit';
          if (!next || next !== expectedNext || type !== expectedType || next.length !== spec.commit.length) {
            throw new Error('source tag chain failed validation');
          }
          target = next;
        }
      } else if (await git(cache, ['cat-file', '-t', tag.object], env) !== 'commit'
        || tag.object !== tag.peeledCommit || !closure.has(tag.object)) {
        throw new Error('lightweight source tag does not point into candidate history');
      }
      await git(cache, ['merge-base', '--is-ancestor', tag.peeledCommit, spec.commit], env);
    }
    for (const commit of roots) await git(cache, ['update-ref', `refs/pullboard/candidates/${commit}`, commit], env);
    await git(root, ['init', '-q', `--object-format=${spec.commit.length === 64 ? 'sha256' : 'sha1'}`], env);
    await git(root, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', cache, `refs/pullboard/candidates/${spec.commit}`], env);
    await git(root, ['checkout', '--detach', 'FETCH_HEAD'], env);
    if (spec.trustedMode) {
      const mode = spec.trustedMode;
      await git(root, ['check-ref-format', mode.trunk.ref], env);
      await git(root, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', cache,
        `refs/pullboard/candidates/${mode.policyCommit}:refs/pullboard/trusted-policy`,
        `refs/pullboard/candidates/${mode.trunk.commit}:${mode.trunk.ref}`], env);
      await git(root, ['config', '--local', '--replace-all', 'pullboard.trunk', mode.trunk.ref], env);
    }
    for (let index = 0; index < spec.tags.length; index++) {
      const tag = spec.tags[index];
      const deliveryRef = `refs/pullboard/tag-delivery/${spec.id}/${index}`;
      await git(cache, ['update-ref', deliveryRef, tag.object], env);
      deliveryRefs.push(deliveryRef);
      await git(root, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', cache, `${deliveryRef}:${tag.name}`], env);
      if (await git(root, ['rev-parse', `${tag.name}^{}`], env) !== tag.peeledCommit) {
        throw new Error('isolated source checkout has an invalid tag ref');
      }
    }
    if (await git(root, ['rev-parse', 'HEAD'], env) !== spec.commit
      || await git(root, ['rev-parse', 'HEAD^{tree}'], env) !== spec.tree
      || await git(root, ['rev-parse', '--is-shallow-repository'], env) !== 'false'
      || existsSync(join(root, '.git', 'objects', 'info', 'alternates'))) {
      throw new Error('isolated source checkout does not contain the complete requested history');
    }
  } finally {
    for (const ref of deliveryRefs) {
      try { await git(cache, ['update-ref', '-d', ref], env); } catch { /* Leave cache refs only if Git refuses safe removal. */ }
    }
    try { cacheLease.release(); } catch { /* Retaining the lease on cleanup error is safer than speculative deletion. */ }
  }
  rmSync(packFile, { force: true });
}

/** Install committed npm dependencies through an isolated content-addressed cache, refusing unknown lock managers. */
async function installDependencies(root, runnerRoot, env, tracker) {
  const packageFile = join(root, 'package.json');
  if (!existsSync(packageFile)) return;
  const packageText = readFileSync(packageFile, 'utf8');
  const manifest = JSON.parse(packageText);
  const lockFile = join(root, 'package-lock.json');
  if (existsSync(join(root, 'pnpm-lock.yaml')) || existsSync(join(root, 'yarn.lock'))) {
    throw new Error('dependency setup requires a single committed npm lock manager');
  }
  if (!existsSync(lockFile)) {
    if (Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.devDependencies ?? {}).length) {
      throw new Error('dependency setup requires a committed npm package-lock.json');
    }
    return;
  }
  const cacheRoot = join(runnerRoot, 'cache', 'npm');
  const contentCache = join(cacheRoot, 'content');
  mkdirSync(contentCache, { recursive: true, mode: 0o700 });
  chmodSync(cacheRoot, 0o700); chmodSync(contentCache, 0o700);
  // node_modules is job-local because package lifecycle scripts may create sibling artifacts.
  // Reuse only npm's content-addressed download cache, never a prior job's installed tree.
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  const npm = spawnOwned('npm', ['ci', '--cache', contentCache], {
    cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'],
  });
  const result = await npm.closed;
  await tracker.stopDescendants();
  await drainOwned(npm);
  if (result.error || result.code !== 0 || result.signal) throw new Error('committed npm dependencies could not be installed');
}

/** Wait until all bytes written to stdout have passed through the stream before publishing a receipt. */
async function flushStdout() {
  if (process.stdout.writableNeedDrain) await once(process.stdout, 'drain');
  await new Promise((resolveFlush, rejectFlush) => process.stdout.write('', error => error ? rejectFlush(error) : resolveFlush()));
}

/** Emit command output through one stream while computing the receipt's byte-exact digest. */
function outputSink() {
  const hash = createHash('sha256');
  const wallStart = Date.now();
  let pipeFailed = false;
  let length = 0;
  const write = part => {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    hash.update(bytes);
    length += bytes.length;
    // A lost transport never drains. Discard instead of waiting: a paused command pipe never closes, its group never
    // finishes draining, and with only unref'd timers left the worker exits before releasing its lease (#888).
    if (transportLost || process.stdout.destroyed) return Promise.resolve();
    if (!process.stdout.write(bytes)) return Promise.race([once(process.stdout, 'drain'), transportGone]);
    return Promise.resolve();
  };
  return { hash, write, get length() { return length; }, get pipeFailed() { return pipeFailed; }, set pipeFailed(value) { pipeFailed = value; }, wallStart };
}

/** Stop only the detached command process group owned by this worker, then await its close event. */
async function stopOwnedGroup(pid, closed, tracker) {
  if (!pid) return;
  const signal = async type => {
    for (;;) {
      // Keep null (an ambiguous census, or EPERM) distinct from false, so it retries instead of passing as drained.
      const sent = tracker ? tracker.signalOwnedGroup(pid, type) : false;
      if (sent === true || sent === false) return sent;
      await new Promise(resolvePause => setTimeout(resolvePause, 250));
    }
  };
  await signal('SIGTERM');
  // Give the whole owned group two seconds to handle TERM, even if its leader exits first.
  const graceUntil = Date.now() + 2_000;
  while (Date.now() < graceUntil) {
    const sent = await signal('SIGTERM');
    if (!sent) break;
    await new Promise(resolvePause => setTimeout(resolvePause, 25));
  }
  for (;;) {
    const sent = await signal('SIGKILL');
    if (!sent) break;
    await new Promise(resolvePause => setTimeout(resolvePause, 50));
  }
  await closed;
}

/**
 * Run the exact requested command in its isolated checkout, retaining raw output and real test exit status.
 * A failed command also carries any file denial's evidence, classified here against this checkout (#706).
 */
async function runCommand(spec, root, env, sink, tracker, { continuation = false } = {}) {
  const commandCleanup = continuation ? beginPhaseCleanup : beginCleanup;
  const split = spec.stageMarker ? gateStages(spec.command) : null;
  const pipes = split?.some(stage => stage.pipeline.length > 1) ? mkdtempSync(join(dirname(root), 'gate-pipes-')) : null;
  const command = split ? `(\n${stagedScript(split, spec.stageMarker, pipes)}\n) 2>&1` : spec.command;
  let shell = '/bin/sh';
  let args = ['-c', command];
  if (spec.pipefail) {
    const probe = spawnSync(shell, ['-c', 'set -o pipefail'], { env, stdio: 'ignore' });
    if (probe.status === 0) args = ['-c', `set -o pipefail\n${command}`];
    else if (existsSync('/bin/bash')) { shell = '/bin/bash'; args = ['-o', 'pipefail', '-c', command]; }
    else if (/(?:^|[^|])\|(?:[^|]|$)/u.test(spec.command)) throw new Error('runner shell cannot enforce pipefail');
  }
  const owned = spawnOwned(shell, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = owned.child;
  // A surviving descendant can keep stdio open after the command leader exits.
  // Start the budget at exit rather than waiting for those pipes to close.
  child.once('exit', commandCleanup);
  let outputError = null;
  let writes = Promise.resolve();
  const closed = owned.closed;
  const onDrop = () => { sink.pipeFailed = true; transportDrop(); };
  const denials = fileDenialWatcher(root);
  const forward = stream => stream.on('data', part => {
    stream.pause();
    if (!outputError) writes = writes.then(() => { denials.push(part); return sink.write(part); }).then(() => stream.resume()).catch(error => { outputError = error; onDrop(); });
  });
  forward(child.stdout); forward(child.stderr);
  let timedOut = false;
  let timeoutDrain;
  const timeout = spec.timeoutMs ? setTimeout(() => {
    timedOut = true; beginCleanup();
    timeoutDrain = tracker.stopDescendants().then(() => drainOwned(owned, true));
    timeoutDrain.catch(() => {});
  }, spec.timeoutMs) : null;
  const result = await closed;
  clearTimeout(timeout);
  if (timeoutDrain) await timeoutDrain;
  commandCleanup();
  cleanupStage = 'command output';
  await writes;
  cleanupStage = 'command descendants';
  await tracker.stopDescendants();
  cleanupStage = 'command process group';
  await drainOwned(owned);
  if (transportDrain) await transportDrain;
  if (outputError) throw outputError;
  if (sink.pipeFailed) return { code: 1, signal: result.signal ?? 'SIGHUP' };
  if (result.error) throw result.error;
  const code = Number.isInteger(result.code) ? result.code : 1;
  if (continuation && code === 0 && !result.signal && !timedOut && !outputError && !sink.pipeFailed) {
    await tracker.verifyAfterGroups();
    if (!clearPhaseCleanup()) throw new Error('intermediate install cleanup could not be verified within its deadline');
  }
  const denial = code === 0 && !result.signal ? null : denials.end();
  let pipeStatuses = pipes ? readPipes(split, pipes, 8 * 1024 ** 2) : null;
  // Accounting beyond this bound fails closed; it never turns an unaccounted failure green.
  if (Buffer.byteLength(JSON.stringify(pipeStatuses)) > 8 * 1024 ** 2) pipeStatuses = null;
  return { code: timedOut ? 1 : code, signal: result.signal ?? null, ...(timedOut ? { timedOut: true } : {}), ...(spec.stageMarker ? { pipeStatuses } : {}), ...(denial ? { denial } : {}) };
}

/** Apply only the frozen declarative guard inside this exact private checkout, never a controller callback. */
async function applyPrivateGuard(root, guard, env) {
  if (!guard) return null;
  try {
    const path = join(root, guard.patch ?? guard.path);
    const canonical = realpathSync(path);
    if (!canonical.startsWith(realpathSync(root) + '/')) throw new Error('guard escapes its private checkout');
    if (guard.patch) await git(root, ['apply', '-R', '--whitespace=nowarn', '--', guard.patch], env);
    else {
      const lines = readFileSync(path, 'utf8').split('\n');
      if (guard.to > lines.length) throw new Error('guard lines are absent');
      lines.splice(guard.from - 1, guard.to - guard.from + 1);
      writeFileSync(path, lines.join('\n'));
    }
    return { applied: true, problem: '' };
  } catch { return { applied: false, problem: `guard ${guard.text} cannot be reverted inside the submitted checkout`.slice(0, 4096) }; }
}

/** Execute the trusted phases against one absolute policy deadline, with worker-owned byte boundaries. */
async function runPrivateCheck(spec, root, env, sink, tracker) {
  const mode = spec.trustedMode;
  const phases = { install: null, check: null };
  const guard = await applyPrivateGuard(root, mode.guard, env);
  let problem = guard && !guard.applied ? { stage: 'guard', message: guard.problem } : null;
  const deadline = Date.now() + mode.timeoutMs;
  let denial = null;
  /** Capture phase framing outside command output, so candidate text cannot forge a phase receipt. */
  const phase = async (name, command, continuation) => {
    const offset = sink.length;
    const hash = createHash('sha256');
    const phaseSink = Object.create(sink);
    phaseSink.write = part => { const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part); hash.update(bytes); return sink.write(bytes); };
    const remaining = deadline - Date.now();
    if (remaining <= 0) { problem = { stage: name, message: `${name} timed out` }; return null; }
    let result;
    try { result = await runCommand({ ...spec, command, stageMarker: undefined, timeoutMs: remaining, pipefail: false }, root, env, phaseSink, tracker, { continuation }); }
    catch {
      problem = { stage: name, message: `${name} could not start or its output could not be saved` };
      result = { code: 1, signal: null };
    }
    denial = result.denial ?? denial;
    const value = { offset, length: sink.length - offset, sha256: hash.digest('hex'), code: result.code, signal: result.signal ?? null, timedOut: result.timedOut === true };
    phases[name] = value;
    return value;
  };
  if (!problem && mode.install) await phase('install', mode.install, true);
  const installed = !mode.install || phases.install?.code === 0 && !phases.install.signal && !phases.install.timedOut;
  if (!problem && installed) await phase('check', mode.check, false);
  const last = phases.check ?? phases.install;
  let sourceUnchanged = false;
  if (!mode.guard) {
    try {
      const state = (await git(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], env)).split('\n').filter(Boolean);
      sourceUnchanged = state.includes('# branch.oid ' + spec.commit) && state.every(line => line.startsWith('# '));
    } catch { sourceUnchanged = false; }
  }
  return { code: problem ? 1 : last?.code ?? 1, signal: last?.signal ?? null, ...(denial ? { denial } : {}),
    trustedMode: { kind: 'private-check', version: 1, requestSha256: mode.sha256, phases, guard, sourceUnchanged, ...(problem ? { problem } : {}) } };
}

/** Send the single nonce-bound result line after the complete merged output has drained. */
async function receipt(spec, fields, sink) {
  await flushStdout();
  const body = { id: spec.id, commit: spec.commit, tree: spec.tree, code: fields.code, signal: fields.signal,
    environment: executionEnvironment(), testRuntimes: fields.testRuntimes ?? null, gui: fields.gui ?? null, timing: spec.timing === true, executionAdmission: fields.executionAdmission ?? null,
    runtimeSha256: spec.runtime.sha256, toolingSha256: spec.tooling.sha256, root: fields.root ?? '', outputSha256: sink.hash.digest('hex'), wallMs: Math.max(0, Date.now() - sink.wallStart),
    // The execution host's load and the pinned main this run used, so a paired rerun here can be judged (#925).
    main: typeof spec.main === 'string' ? spec.main : null, load: { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) },
    ...(fields.trustedMode ? { trustedMode: fields.trustedMode } : {}),
    ...(spec.stageMarker ? { pipeStatuses: fields.pipeStatuses ?? null } : {}), ...(fields.timedOut ? { timedOut: true } : {}), ...(fields.refused ? { refused: fields.refused } : {}), ...(fields.browserRefused ? { browserRefused: true } : {}), ...(fields.denial ? { denial: fields.denial } : {}) };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
  await new Promise((resolveWrite, rejectWrite) => process.stderr.write(`${RECEIPT} ${spec.id} ${encoded}\n`, error => error ? rejectWrite(error) : resolveWrite()));
}

/**
 * Name the rule when the runner's own resource API refused setup. The code is a fixed identifier,
 * so it can travel to the controller where paths and runner state cannot.
 */
function setupRefusalCode(error) {
  return error?.name === 'Refused' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(String(error.code ?? '')) ? error.code : '';
}

/**
 * End this worker's read of the controller's stream once nothing more will be read from it.
 * Only the history pack drains stdin to its end; a run that stops before the pack would otherwise
 * keep the worker, and so the SSH session and the run, alive after its receipt.
 */
function stopReading() {
  process.stdin.destroy();
}

/** Name a setup phase and bounded cause while hiding private paths and credentials. */
function safeSetupMessage(error, step) {
  if (error?.runnerSetup) {
    const detail = error.runnerSetup;
    return `runner setup refused: ${detail.step} failed (${detail.status})\ngit stderr: ${detail.stderr || '(none)'}`;
  }
  const message = String(error?.message ?? '');
  const category = message.includes('npm') || message.includes('dependency') ? 'committed dependencies are unavailable'
    : message.includes('capacity') || message.includes('queue') ? 'remote capacity is unavailable' : 'source checkout could not be prepared';
  const code = /^[A-Z][A-Z0-9_]{0,63}$/u.test(error?.code ?? '') ? ` (${error.code})` : '';
  const cause = safeGitDiagnostic(message, '', { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR });
  return `runner setup refused: ${category}; step: ${error?.runnerSetupStep ?? step}${code}\ncause: ${cause || '(unavailable)'}`;
}

/** Execute one remote job end to end; stdout is reserved for raw command bytes and stderr for one receipt. */
async function main() {
  installSignalCustody();
  const spec = await readSpec();
  workerId = spec.id;
  if (spec.browserRequired && spec.browser < 1) throw new Error('browser capacity is not configured');
  const sink = outputSink();
  let api;
  let lease = null;
  let tracker = null;
  let runtimeCapture = null;
  let runDirectory;
  let setupStep = 'runner directories';
  let gui = null;
  let final = { code: 1, signal: null, root: '' };
  try {
    const runnerHome = isAbsolute(process.env.HOME || '') ? process.env.HOME : userInfo().homedir;
    const runnerRoot = spec.root ?? join(runnerHome, '.pullboard-runner');
    setupPrivatePaths.add(runnerRoot);
    mkdirSync(runnerRoot, { recursive: true, mode: 0o700 });
    setupPrivatePaths.add(realpathSync(runnerRoot));
    chmodSync(runnerRoot, 0o700);
    const configuredMachineHome = process.env.PULLBOARD_MACHINE_HOME;
    if (configuredMachineHome !== undefined && !isAbsolute(configuredMachineHome)) throw new Error('machine home is invalid');
    const machineHomePath = configuredMachineHome ?? join(runnerHome, '.pullboard');
    setupPrivatePaths.add(machineHomePath);
    setupStep = 'trusted resource API';
    api = loadResourceApi(spec.runtime);
    // The registration travels with the job; this machine's own settings never size a runner (#1066).
    const { gateCapacity, browserCapacity } = registeredCapacity(api, spec, runnerRoot, machineHomePath);
    setupStep = 'job directories';
    const base = join(runnerRoot, 'jobs');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    chmodSync(base, 0o700);
    runDirectory = mkdtempSync(join(base, `${spec.id}-`));
    cleanupDirectory = runDirectory;
    const root = join(runDirectory, 'checkout');
    const privateHome = join(runDirectory, 'home');
    const temporary = join(runDirectory, 'tmp');
    mkdirSync(root, { mode: 0o700 }); mkdirSync(privateHome, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
    writeFileSync(join(privateHome, 'npm-userconfig'), '', { mode: 0o600 });
    writeFileSync(join(privateHome, 'npm-globalconfig'), '', { mode: 0o600 });
    const packFile = join(runDirectory, 'source.pack');
    setupStep = 'runner gate admission';
    lease = await acquireResourceApi(api, {
      name: 'gate', capacity: gateCapacity, scope: 'machine', root: runnerRoot, runnerExecution: true,
      repo: runnerRoot, agent: `pullboard-ssh-${spec.id}`,
      landing: spec.landing === true, itemCheck: spec.itemCheck === true,
      diagnostic: spec.diagnostic === true, browser: spec.browserRequired, timing: spec.timing === true,
      browserCapacityProvider: () => browserCapacity,
      item: spec.item ?? '', kind: spec.kind ?? 'remote-command',
      onWait: () => assertTransportLive(),
    }, machineHomePath);
    gui = guiSession();
    if (spec.guiRequired && gui !== true) throw new Refused('RUNNER_GUI_SESSION_REQUIRED', 'log in to a GUI session on this runner or keep GUI-marked files local');
    const startLoad = sampleRunnerLoad();
    lease.executionAdmission = { admittedAt: lease.admittedAt, slots: gateCapacity, load: { start: startLoad, end: null } };
    const canonicalMachineHome = machineHomePath;
    tracker = createDescendantTracker(runDirectory, {
      tick: reportCleanupTimeout, timedOut: () => cleanupTimedOut,
      warn: reason => process.stderr.write(`PULLBOARD_RUNNER_CLEANUP_UNVERIFIED ${workerId} ${reason}\n`),
    });
    cleanupDetails = tracker.cleanupState;
    activeDescendantTracker = tracker;
    runtimeCapture = captureTestRuntimes(scopedEnvironment(privateHome, temporary, canonicalMachineHome, lease, api, tracker.nodeOptions));
    const env = runtimeCapture.env;
    setupStep = 'source history checkout';
    await checkoutHistory(api, runnerRoot, root, packFile, spec, env);
    if (!spec.trustedMode) {
      setupStep = 'committed dependencies';
      await installDependencies(root, runnerRoot, env, tracker);
    }
    setupStep = 'command start';
    const browserRefusal = join(runDirectory, 'browser-refusal.json');
    const commandEnv = { ...env, PULLBOARD_LANDING_RUN: spec.landing === true ? '1' : '0', [api.BROWSER_REFUSAL_FILE_ENV]: browserRefusal, ...(typeof spec.browserByLaunch === 'boolean' ? { PULLBOARD_TEST_BROWSER_BY_LAUNCH: spec.browserByLaunch ? '1' : '0' } : {}), PULLBOARD_LANDING_WAIVERS: JSON.stringify(spec.landing === true ? spec.waivers ?? [] : []) };
    process.stderr.write(`PULLBOARD_RUNNER_READY ${spec.id}\n`);
    final = { ...(spec.trustedMode ? await runPrivateCheck(spec, root, commandEnv, sink, tracker) : await runCommand(spec, root, commandEnv, sink, tracker)), root };
    if (final.code !== 0 && existsSync(browserRefusal)) final.browserRefused = true;
  } catch (error) {
    const refused = setupRefusalCode(error);
    const message = refused ? `${safeSetupMessage(error, setupStep)} [${refused}]` : safeSetupMessage(error, setupStep);
    if (!transportLost && !spec?.trustedMode) await sink.write(`${message}\n`);
    final = { code: 1, signal: transportLost ? 'SIGHUP' : null, error: message, root: '', ...(refused ? { refused } : {}),
      ...(spec?.trustedMode ? { trustedMode: { kind: 'private-check', version: 1, requestSha256: spec.trustedMode.sha256,
        phases: { install: null, check: null }, guard: spec.trustedMode.guard ? { applied: false, problem: message } : null,
        sourceUnchanged: false, problem: { stage: 'check', message } } } : {}) };
  } finally {
    beginCleanup();
    cleanupStage = 'final descendants';
    if (tracker) await tracker.stopDescendants();
    cleanupStage = 'final process groups';
    await drainAllOwned();
    if (tracker) {
      cleanupStage = 'final verification';
      await tracker.verifyAfterGroups();
      tracker.stopMonitoring();
      activeDescendantTracker = null;
    }
    if (lease) {
      cleanupStage = 'lease release';
      try {
        if (lease.executionAdmission) {
          const endLoad = sampleRunnerLoad();
          final.executionAdmission = { ...lease.executionAdmission, ...lease.timingEvidence(), finishedAt: endLoad.at, load: { ...lease.executionAdmission.load, end: endLoad } };
        }
      } finally { await releaseDrainedLease(lease); }
    }
    final.testRuntimes = runtimeCapture?.finish() ?? null;
    cleanupStage = 'job files';
    if (runDirectory && !cleanupTimedOut) { try { rmSync(runDirectory, { recursive: true, force: true }); } catch {} }
  }
  if (transportLost || cleanupTimedOut) { clearTimeout(cleanupTimer); clearTimeout(phaseCleanupTimer); process.exitCode = 1; stopReading(); return; }
  cleanupStage = 'result receipt';
  await receipt(spec, { ...final, gui }, sink);
  clearTimeout(cleanupTimer);
  clearTimeout(phaseCleanupTimer);
  process.exitCode = 0;
  stopReading();
}

main().catch(() => { process.exitCode = 1; });
