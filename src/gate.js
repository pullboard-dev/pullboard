/**
 * The gate (V4, C3, Q1, Q2, V18): the repo's check command and shared queue for gates and item checks. A green
 * run over a committed tree, with nothing untracked and nothing changed while it ran, leaves that
 * tree's id in the git dir, so the same tree is never checked twice. An agent sees a digest of the
 * run, not the run (V10): a passing suite's output costs tokens and says nothing.
 */
import {
  checkNeedsGui,
  projectNeedsGui,
  testsNeedGui,
} from './gui-admission.js';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  availableParallelism,
  freemem,
  loadavg,
} from 'node:os';
import { fileURLToPath } from 'node:url';
import { executionEnvironment } from './execution-environment.js';
import { constrainedLandingHost } from './landing-host.js';
import {
  gitChildEnv,
  gitPath,
  headCommit,
  headTree,
  invalidateGitFacts,
  isClean,
  untracked,
} from './git.js';
import { recordGateRun } from './gate-control.js';
import {
  receiptBody,
  receiptFields,
  receiptStore,
} from './gate-run-receipt.js';
import {
  committedTest,
  tapTests,
} from './tap-tests.js';
import { mainPolicy } from './trusted-policy.js';
import { secretsIn } from './hooks.js';
import { Refused } from './refused.js';
import { missingGate } from './gate-config.js';
import {
  GATE_SLOT_HELD_ENV,
  gateSlotEnvironment,
  inheritedGateSlot,
  memoryAdmission,
  readMachineMemory,
  takeResource,
} from './resources.js';
import {
  browserFreeChecksEnabled,
  gateRunnersFirstEnabled,
  gateQueueSettings,
  gateShortSlots,
  loadMachineSettings,
  memoryFloorMB,
} from './settings.js';
import { selectAffectedTests } from './affected-tests.js';
import { selectRegistryGuards } from './registry-guards.js';
import {
  checkNeedsBrowser,
  testsNeedBrowser,
} from './browser-admission.js';
import {
  timingFromOutput,
  timingRunner,
} from './timing.js';
import { landingShardProfile } from './landing-shards.js';
import { localRunnerDescriptor } from './runner-load.js';
import { sampleRunnerLoad } from './runner-load.js';
import { receiptLine } from './gate-receipt.js';
import { receiptOf } from './gate-receipt.js';
import { recordReceipt } from './gate-receipt.js';
import { slotOf } from './gate-receipt.js';
import { startReceipt } from './gate-receipt.js';
export { gateStages } from './gate-stages.js';
// A read that checks a baseline runs one command without loading the gate's queue and runners.
import { runShell } from './shell-run.js';
import {
  digestOf,
  writeTimingProfile,
} from './gate-output.js';
// A read that checks a baseline or a trusted policy summarizes output without loading the gate's queue and runners.
export { digestOf, runShell, writeTimingProfile };
import {
  RunnerDropped,
  runOnRunner,
  runOnRunnerAsync,
  runnerSource,
} from './runners.js';
import {
  sandboxBlockedOperation,
  sandboxBlockedScanner,
} from './sandbox-denial.js';

// Callers keep importing the classifier from the gate; the runner worker imports it directly.
export { sandboxBlockedOperation, sandboxBlockedScanner };

const STAMP = 'pullboard-gate-green';
const LOG = 'pullboard-gate.log';
const LANDING_RUN_ENV = 'PULLBOARD_LANDING_RUN';
// Live person waivers, as {kind, test}, so a landing run does not stop early on a waived failure.
const LANDING_WAIVERS_ENV = 'PULLBOARD_LANDING_WAIVERS';
/** Detect the performance-core budget on Apple Silicon, or the runtime's usable CPU budget elsewhere. */
export function performanceCores() {
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu'], { encoding: 'utf8' });
    const count = Number(result.stdout?.trim());
    if (result.status === 0 && Number.isSafeInteger(count) && count > 0) return count;
  }
  return Math.max(1, availableParallelism());
}

/** One policy for native file concurrency and the separate per-run browser-file limit. */
export function testConcurrency(root, cores = performanceCores()) {
  const file = join(root, 'pullboard.json');
  let config = {};
  if (existsSync(file)) {
    try { config = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Refused('BAD_CONFIG', 'pullboard.json must be valid JSON before running tests'); }
  }
  const setting = config.testConcurrency ?? {};
  if (!setting || typeof setting !== 'object' || Array.isArray(setting)) {
    throw new Refused('BAD_CONFIG', 'testConcurrency must be an object with positive integer files and browser fields');
  }
  const files = setting.files ?? cores;
  const browser = setting.browser ?? 2;
  if (!Number.isSafeInteger(files) || files < 1 || !Number.isSafeInteger(browser) || browser < 1 || browser > 2) {
    throw new Refused('BAD_CONFIG', 'testConcurrency.files must be positive; testConcurrency.browser must be 1 or 2');
  }
  return { files, browser: Math.min(files, browser) };
}

/**
 * How many shards the landing gate's test files split into: `landingShards` in pullboard.json,
 * 1 when absent, which keeps today's single run.
 *
 * @param {string} root
 * @returns {number}
 */
export function landingShardCount(root) {
  const file = join(root, 'pullboard.json');
  if (!existsSync(file)) return 1;
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Refused('BAD_CONFIG', 'pullboard.json must be valid JSON before running tests'); }
  const count = config?.landingShards ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 64) {
    throw new Refused('BAD_CONFIG', 'landingShards must be a whole number from 1 to 64; set it in pullboard.json, or remove it for one landing run');
  }
  return count;
}

/**
 * The tree a gate run would check, or null when the working copy differs from HEAD or holds
 * untracked files, since a pass over it would vouch for something no commit holds.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function committedTree(root) {
  if (!isClean(root) || untracked(root).length) return null;
  return headTree(root);
}

/**
 * True when the gate already passed on exactly this committed tree.
 *
 * @param {string} root
 * @returns {boolean}
 */
export function isStampedGreen(root) {
  const tree = committedTree(root);
  const file = gitPath(root, STAMP);
  return tree !== null && existsSync(file) && readFileSync(file, 'utf8').trim() === tree;
}

/** Refuse an environment-blocked proof after its ordinary raw logs and timings are persisted. */
export function refuseSandboxBlocked(run) {
  if (run.sandboxBlocked) throw new Refused('SANDBOX_BLOCKED',
    `The environment refused ${run.sandboxBlocked}. Ask the coordinator to bring this operation to the person, or run the gate outside the sandbox; keep the tests unchanged.`);
}

/** Replace a possible secret-bearing line before persisting a direct item-check log. */
function safeLog(output) {
  return output.split('\n').map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > 64 * 1024) return '[redacted output line exceeds 64 KiB safe-scan limit]';
    const findings = secretsIn([{ path: 'item check output', line: index + 1, text: line }]);
    return findings.length ? `[redacted ${findings.map(finding => finding.slice(0, finding.lastIndexOf(' at '))).join(', ')}]` : line;
  }).join('\n');
}

/** Run the unchanged caller command and profile only timings already present in its output.
 * @param {string} root
 * @param {string} command
 * @param {{ waitMs?: number, artifactDirectory?: string, artifactPrefix?: string, persistLog?: boolean, profileFile?: string, pipefail?: boolean, gateSlotHeld?: boolean, gateLease?: object, landing?: boolean, stages?: boolean, timeoutMs?: number, waivers?: Array<{ kind: string, test: string }> }} [options]
 */
export function runProfiledShell(root, command, { waitMs = 0, artifactDirectory, artifactPrefix = 'pullboard-gate', persistLog = false, profileFile, pipefail = false, gateSlotHeld = false, gateLease, landing = false, stages = false, waivers = [], timeoutMs } = {}) {
  const directory = artifactDirectory ?? dirname(gitPath(root, LOG));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const profilePath = profileFile ?? join(directory, `${artifactPrefix}-${id}.profile.json`);
  const logPath = persistLog ? join(directory, `${artifactPrefix}-${id}.log`) : null;
  const started = Date.now();
  const inherited = {
    ...(gateLease && !gateLease.runner ? gateSlotEnvironment(gateLease) : gateSlotHeld ? { [GATE_SLOT_HELD_ENV]: '1' } : {}),
    [LANDING_RUN_ENV]: landing ? '1' : '0',
    [LANDING_WAIVERS_ENV]: landing ? JSON.stringify(waivers) : '[]',
    // A reused test result names the stage that ran it (#1045).
    PULLBOARD_TEST_STAGE: gateLease?.receiptKind ?? (landing ? 'land' : 'gate'),
  };
  // The registered worker returns the same complete stage/component accounting as a local run.
  gateLease?.tracker?.mark('runAt');
  const run = gateLease?.runner ? { ...runOnRunner(root, command, { runner: gateLease.runner, source: gateLease.source,
    browser: gateLease.browser, pipefail, stages, waivers: landing ? waivers : [], metadata: { ...(gateLease.runMetadata ?? {}), landing, ...(timeoutMs ? { timeoutMs } : {}) } }) }
    : runShell(root, command, { pipefail, env: inherited, stages, timeoutMs });
  gateLease?.tracker?.mark('ranAt');
  if (gateLease) {
    gateLease.environment = run.environment ?? null;
    gateLease.gui = run.executionCapabilities?.gui ?? null;
    gateLease.executionAdmission = run.executionAdmission ?? null;
  }
  const sandboxBlocked = run.isGreen ? null : run.sandboxBlocked ?? (run.executionRunner
    // The controller cannot realpath remote files; retain the network denial signal without treating remote paths as local paths.
    ? sandboxBlockedOperation(root, run.output, { includeFilePaths: false })
    : sandboxBlockedOperation(root, run.output));
  const profiledRun = { ...run, sandboxBlocked };
  if (logPath) writeFileSync(logPath, safeLog(run.output), { mode: 0o600 });
  const profile = writeTimingProfile(profilePath, {
    ...runTiming(profiledRun, command),
    waitMs: Math.max(0, Math.round(waitMs)), wallMs: Math.max(0, Date.now() - started), receipt: settleReceipt(gateLease),
  });
  return { ...profiledRun, profile, profilePath, logPath };
}

/** Run an independent focused comparison without blocking other holders of the machine pool.
 * @param {string} root
 * @param {string} command
 * @param {{ waitMs?: number, gateSlotHeld?: boolean, gateLease?: object, landing?: boolean }} [options]
 * @returns {Promise<object>} The unchanged shell verdict and its private timing profile.
 */
export async function runProfiledShellAsync(root, command, { waitMs = 0, gateSlotHeld = false, gateLease, landing = false } = {}) {
  const started = Date.now();
  gateLease?.tracker?.mark('runAt');
  if (gateLease?.runner) {
    const run = await runOnRunnerAsync(root, command, { runner: gateLease.runner, source: gateLease.source,
      browser: gateLease.browser, metadata: { ...(gateLease.runMetadata ?? {}), landing } });
    gateLease.environment = run.environment ?? null;
    gateLease.gui = run.executionCapabilities?.gui ?? null;
    gateLease.executionAdmission = run.executionAdmission ?? null;
    gateLease.tracker?.mark('ranAt');
    const wallMs = Math.max(0, Date.now() - started);
    const profilePath = join(dirname(gitPath(root, LOG)), `pullboard-gate-${randomUUID()}.profile.json`);
    const sandboxBlocked = run.isGreen ? null : run.sandboxBlocked
      ?? sandboxBlockedOperation(root, run.output, { includeFilePaths: false });
    const profile = writeTimingProfile(profilePath, { ...runTiming(run, command), waitMs, wallMs, receipt: settleReceipt(gateLease) });
    return { ...run, sandboxBlocked, seconds: Math.round(wallMs / 1000), profile, profilePath, logPath: null };
  }
  const inherited = {
    ...(gateLease ? gateSlotEnvironment(gateLease) : gateSlotHeld ? { [GATE_SLOT_HELD_ENV]: '1' } : {}),
    [LANDING_RUN_ENV]: landing ? '1' : '0',
    PULLBOARD_TEST_STAGE: gateLease?.receiptKind ?? (landing ? 'land' : 'gate'),
  };
  const env = { ...gitChildEnv(root), ...inherited };
  const environment = executionEnvironment();
  const child = spawn(`(\n${command}\n) 2>&1`, { cwd: root, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  let failure = null;
  /** Retain merged shell output within the same one-GiB limit as the synchronous gate runner. */
  const capture = part => {
    bytes += Buffer.byteLength(part);
    if (bytes > 2 ** 30) { overflow = true; child.kill(); }
    else chunks.push(part);
  };
  child.stdout.setEncoding('utf8').on('data', capture);
  child.stderr.setEncoding('utf8').on('data', capture);
  child.once('error', error => { failure = error; });
  const status = await new Promise(resolveClose => child.once('close', resolveClose));
  gateLease?.tracker?.mark('ranAt');
  if (gateLease) gateLease.environment = environment;
  invalidateGitFacts();
  const output = chunks.join('') + (overflow ? '\nFocused comparison output exceeded one GiB.\n' : '')
    + (failure ? `\n${failure.message}\n` : '');
  const wallMs = Math.max(0, Date.now() - started);
  const profilePath = join(dirname(gitPath(root, LOG)), `pullboard-gate-${randomUUID()}.profile.json`);
  const profile = writeTimingProfile(profilePath, { ...timingFromOutput(output, timingRunner(command)),
    waitMs: Math.max(0, Math.round(waitMs)), wallMs, receipt: settleReceipt(gateLease) });
  return { isGreen: status === 0 && !overflow && !failure, environment, sandboxBlocked: status === 0 ? null : sandboxBlockedOperation(root, output), output, seconds: Math.round(wallMs / 1000), profile, profilePath, logPath: null };
}

/** Close a gated run's receipt (#836) as its evidence is written; the slot's release records this same receipt. */
function settleReceipt(lease) {
  if (!lease?.tracker) return undefined;
  const executor = lease.executionAdmission;
  const local = !lease.runner;
  const descriptor = local ? lease.localDescriptor ?? localRunnerDescriptor(lease.capacity ?? null, null)
    : { id: lease.runner.host, kind: 'ssh', slots: { current: executor?.slots ?? lease.runner.slots, limit: executor?.slots ?? lease.runner.slots, elastic: false },
      capabilities: { os: lease.environment?.platform ?? null, browser: lease.runner.browser > 0, gui: lease.gui ?? null } };
  const admittedAt = local ? lease.admittedAt ?? new Date(lease.tracker.marks.admittedAt ?? lease.tracker.marks.requestedAt).toISOString() : executor?.admittedAt ?? null;
  const finishedAt = local ? new Date().toISOString() : executor?.finishedAt ?? null;
  const load = local ? { start: lease.startLoad ?? sampleRunnerLoad(), end: sampleRunnerLoad() } : executor?.load ?? null;
  lease.receipt = { ...receiptOf(lease.tracker, { kind: lease.receiptKind, slot: lease.slot }), environment: lease.environment ?? null,
    runner: descriptor, admittedAt, finishedAt, timing: lease.timing === true, inherited: lease.inherited === true,
    occupiedSlots: lease.timing ? descriptor.slots.current : 1, load,
    ...(local ? lease.timingEvidence?.() ?? { exclusive: false, unfencedClients: [] }
      : { exclusive: executor?.exclusive === true, unfencedClients: executor?.unfencedClients ?? [] }) };
  return lease.receipt;
}

/** Keep raw remote TAP intact while resolving its measured filenames against the local source. */
function runTiming(run, command) {
  const shards = landingShardProfile(run.output);
  const profile = { ...timingFromOutput(run.output, timingRunner(command)), ...(shards ? { landingShards: shards } : {}) };
  if (!run.executionRunner) return profile;
  /** Relocate only paths inside the actual remote checkout, never a foreign absolute path. */
  const localPath = path => {
    if (typeof path !== 'string') return path;
    const original = path;
    if (path.startsWith('file:')) {
      try { path = fileURLToPath(path); } catch { return original; }
    }
    if (!isAbsolute(path)) return original;
    const suffix = relative(run.executionRoot, path);
    return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix) ? suffix : original;
  };
  return { ...profile, executionRunner: run.executionRunner, executionSource: run.executionSource,
    files: (profile.files ?? []).map(file => ({ ...file, path: localPath(file.path) })),
    tests: (profile.tests ?? []).map(test => ({ ...test, file: localPath(test.file) })) };
}

/** Run work under the machine queue: landings first, then every other eligible waiter in arrival order.
 * Local executors wait while this machine is out of memory; remote runners keep admitting.
 *
 * @param {string} root - Checkout used to locate the machine resource database.
 * shortEligible marks a run that names its test files: with gate.shortSlots above 0 it may take a
 * short slot when every ordinary slot is held, and a full suite can never inherit that slot. A memory
 * hold (gate.memoryFloorMB) holds short slots too, since a short run uses the same machine memory.
 *
 * @param {(lease: { waitMs: number, token?: string, pool?: string, browser?: boolean, slotClass?: 'gate'|'short', release: () => void }) => any | Promise<any>} action - Work to perform while holding a slot.
 * @param {{ landing?: boolean, itemCheck?: boolean, shortEligible?: boolean, diagnostic?: boolean, browser?: boolean, gui?: boolean, remote?: boolean, timing?: boolean, agent?: string, item?: string|number, kind?: string, onWait?: (state: object) => void, onReceipt?: (receipt: object) => void, readMemory?: typeof readMachineMemory }} [options] - Queue class, short-slot eligibility, remote eligibility, progress reporter, the run's receipt once its slot is released (#836) and, for tests, the machine memory reader.
 * @returns {Promise<any>} The action's result after releasing its lease.
 */
export async function withGateSlot(root, action, options = {}) {
  try { return await withOneGateSlot(root, action, options); }
  catch (error) {
    if (!['RUNNER_BROWSER_SLOT_REQUIRED', 'RUNNER_GUI_SESSION_REQUIRED'].includes(error?.code) || options.remote === false) throw error;
    // The runner's red attempt stays on record beside the local rerun.
    const attempt = error.runnerAttempt ?? { host: '', exitCode: null, output: '' };
    const required = error.code === 'RUNNER_GUI_SESSION_REQUIRED' ? 'a GUI session' : 'a browser slot';
    process.stderr.write(`${error.message}; its attempt (exit ${attempt.exitCode}):\n${attempt.output}${attempt.output.endsWith('\n') || !attempt.output ? '' : '\n'}rerunning it locally with ${required}\n`);
    const result = await withOneGateSlot(root, action, { ...options, remote: false, browser: true });
    if (result && typeof result === 'object') result.runnerAttempt = attempt;
    return result;
  }
}

/** Validate landing membership before admission; generic SSH capacity cannot stand in for a constrained host. */
export async function withLandingGateSlot(root, action, options = {}) {
  const constrained = constrainedLandingHost(root);
  return withGateSlot(root, action, { ...options, landing: true, ...(constrained ? { remote: false } : {}) });
}

/** One gate admission and its action; withGateSlot may call it again for a local rerun. */
async function withOneGateSlot(root, action, { landing = false, itemCheck = false, shortEligible = false, diagnostic = false, browser = false, gui = false, remote = true, timing = false, agent, item = '', kind = '', onWait, onReceipt, readMemory = readMachineMemory } = {}) {
  const tracker = startReceipt();
  const receiptKind = kind || (landing ? 'landing' : 'gate');
  /** Hand the run its receipt tracker and slot, then record its receipt once the slot is released (#836). */
  const timed = lease => Object.assign(lease, { tracker, receiptKind,
    ...(!lease.runner ? { startLoad: lease.startLoad ?? sampleRunnerLoad(),
      localDescriptor: localRunnerDescriptor(lease.capacity ?? null, loadMachineSettings().browserSlots > 0) } : {}),
    slot: slotOf(lease, { browserFree: browserFreeChecksEnabled() }) });
  const record = lease => {
    const receipt = lease.receipt ?? receiptOf(tracker, { kind: receiptKind, slot: lease.slot });
    recordReceipt(root, receipt);
    onReceipt?.(receipt);
  };
  const inherited = inheritedGateSlot({ root, browser, namedFiles: shortEligible, timing });
  if (inherited) {
    timed(Object.assign(inherited, { inherited: true })).tracker.mark('actionAt');
    try { return await action(inherited); }
    finally {
      try { settleReceipt(inherited); } finally { inherited.release(); }
      record(inherited);
    }
  }
  const settingsProvider = () => loadMachineSettings();
  const floorMB = memoryFloorMB();
  const capacityProvider = () => settingsProvider().gateSlots;
  const source = runnerSource(root);
  // Read the board once before queueing, never inside the machine admission transaction.
  const releaseContext = gateQueueSettings().currentReleaseFirst
    ? (await import('./release-queue.js')).captureReleaseQueue(root, item) : undefined;
  tracker.mark('queuedAt');
  let lease = await takeResource({
    name: 'gate',
    capacity: capacityProvider(),
    capacityProvider,
    shortCapacityProvider: () => gateShortSlots(),
    shortEligible,
    browserCapacityProvider: () => settingsProvider().browserSlots,
    scope: 'machine',
    root,
    repo: root,
    agent,
    item: String(item),
    kind,
    landing,
    itemCheck,
    diagnostic,
    browser,
    gui,
    timing,
    allowIdleCapacityUpdate: true,
    remote: remote && Boolean(source),
    runnerProvider: () => loadMachineSettings().runners ?? [],
    runnersFirstProvider: gateRunnersFirstEnabled,
    releaseContext,
    memory: floorMB === null ? undefined : memoryAdmission({ floorBytes: () => (memoryFloorMB() ?? floorMB) * 1024 ** 2, read: readMemory }),
    onWait,
  });
  tracker.mark('admittedAt');
  try {
    while (true) {
      lease.source = source;
      lease.runMetadata = { landing, itemCheck, diagnostic, gui, timing, item: String(item), kind };
      timed(lease).tracker.mark('actionAt');
      try { return await action(lease); }
      catch (error) {
        // A cleanup the runner could not verify is the runner's failure, not the run's: rerun it locally (#1063).
        const cleanup = error instanceof Refused && error.code === 'RUNNER_CLEANUP_TIMEOUT';
        if (!(error instanceof RunnerDropped || cleanup) || !lease.runner || !lease.requeueRunner) throw error;
        const runnerUnavailable = { host: lease.runner.host, reason: cleanup ? error.message : 'transport lost before a complete result', until: 'the host is checked and re-registered' };
        if (onWait) await onWait({ holders: [], line: [], position: 0, runnerUnavailable });
        else process.stderr.write(`runner ${runnerUnavailable.host} unavailable: ${runnerUnavailable.reason}; until ${runnerUnavailable.until}; ${cleanup ? 'rerunning it locally' : 'requeueing the run'}\n`);
        lease = await lease.requeueRunner(cleanup ? 'cleanup-unverified' : 'transport-lost', { local: cleanup });
      }
    }
  } finally {
    try { settleReceipt(lease); } finally { lease.release(); }
    record(lease);
  }
}

/** Carry a failure observer's pinned main on the lease, so a remote runner's receipt names the main this run used (#925). */
export function pinRunMain(lease, observer) {
  if (typeof observer?.main === 'string') lease.runMetadata = { ...(lease.runMetadata ?? {}), main: observer.main };
}

/**
 * Run the configured gate in the repo, unless this exact tree already passed. Its output, both
 * streams in order, is kept whole in the git dir and returned for a digest.
 *
 * A passed tree is marked by a stamp file in the git dir, which any agent can write. So the stamp
 * only saves a run where nothing is proven by it, such as pre-push (C3). A submission that falls
 * back to the full gate always runs it afresh (V16).
 *
 * @param {string} root
 * @param {any} config
 * @param {{ trustStamp?: boolean, onWait?: (state: object) => void, landing?: boolean, agent?: string, item?: string|number }} [options]
 * @returns {Promise<{ isGreen: boolean, isCached: boolean, output: string, seconds: number, log: string, profile?: object, profilePath?: string }>}
 */
export async function runGate(root, config, { trustStamp = true, onWait, landing = false, agent, item = '', stages = false, waivers = [], onFailure } = {}) {
  if (!config.gate.trim()) {
    throw missingGate(root);
  }
  if (trustStamp && isStampedGreen(root)) return { isGreen: true, isCached: true, output: '', seconds: 0, log: '' };
  return await (landing ? withLandingGateSlot : withGateSlot)(root, async (lease) => {
    pinRunMain(lease, onFailure);
    const run = fullGateRun(root, config, trustStamp, { waitMs: lease.waitMs, gateLease: lease, landing, stages, waivers, kind: landing ? 'land' : 'gate' });
    if (!run.isGreen && !run.timedOut && onFailure) await onFailure(run, { root, command: config.gate, lease });
    await recordRun(onFailure, run);
    return run;
  }, {
    landing, browser: true, gui: projectNeedsGui(root), agent, item, kind: landing ? 'landing' : 'gate', onWait,
  });
}

/** Hand a run's receipt to its observer, which records it on the board; recording never changes the run's verdict [C7,D1]. */
async function recordRun(observer, run) {
  if (!run.receiptId || typeof observer?.recordRun !== 'function') return;
  try { await observer.recordRun(run.receiptId); } catch { /* A board that cannot take the record leaves the gate result as it was. */ }
}

/**
 * Leave the receipt of one real run of the accepted gate: its tree, the command's digest, its result, the committed
 * tests that failed and the host load, taken from the process this module just ran. It is private to this module on
 * purpose: no caller can hand it a result, so a receipt always describes an execution [C7,D1]. A run of any other
 * command, or one whose checkout was dirty or moved while it ran, proves nothing about a tree and leaves no receipt.
 *
 * @returns {string | null} the receipt id
 */
function leaveRunReceipt(root, config, run, { before, kind }) {
  try {
    if (before === null || committedTree(root) !== before || run.executionSourceUnchanged === false) return null;
    const policy = mainPolicy(root);
    const head = headCommit(root);
    const store = receiptStore(root);
    if (policy.config.gate !== config.gate || !head || !store) return null;
    const failures = new Map();
    for (const row of run.isGreen ? [] : tapTests(run.output ?? '', run.executionRoot ?? root)) {
      if (row.passed || row.skip || row.type === 'suite' || ['subtestsFailed', 'cancelledByParent', 'testAborted'].includes(row.failureType)) continue;
      if (row.file && committedTest(root, head, row.file)) failures.set(JSON.stringify([row.file, row.name]), { file: row.file, name: row.name });
    }
    const local = { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) };
    const receipt = receiptFields({ version: 1, id: randomUUID(), kind, tree: before, head, main: policy.commit, command: createHash('sha256').update(config.gate).digest('hex'),
      green: run.isGreen, failures: [...failures.values()], load: Array.isArray(run.executionLoad?.average) ? run.executionLoad : local, at: new Date().toISOString(), environment: run.environment ?? null });
    if (!receipt) return null;
    mkdirSync(store, { recursive: true, mode: 0o700 });
    writeFileSync(join(store, `${receipt.id}.json`), receiptBody(receipt), { flag: 'wx', mode: 0o600 });
    return receipt.id;
  } catch { return null; }
}

/** Run a full gate while its caller owns the queue lease; only a full run may stamp its tree. */
function fullGateRun(root, config, trustStamp = false, { waitMs = 0, log = gitPath(root, LOG), gateLease, landing = false, stages = false, waivers = [], kind = 'gate' } = {}) {
  if (trustStamp && isStampedGreen(root)) return { isGreen: true, isCached: true, output: '', seconds: 0, log: '' };
  const before = committedTree(root);
  const run = runProfiledShell(root, config.gate, { waitMs, pipefail: true, profileFile: `${log}.profile.json`, gateLease, landing, stages, waivers, timeoutMs: landing ? config.landing?.timeoutMs : undefined });
  const { isGreen, output, seconds, profile, profilePath } = run;
  writeFileSync(log, output);
  // The environment refusing a run says nothing about the gate, so only a real result is recorded (U41).
  if (!run.sandboxBlocked) recordGateRun(root, gateRunRecord(root, config, isGreen, gateLease));
  const receiptId = run.sandboxBlocked ? null : leaveRunReceipt(root, config, run, { before, kind });
  refuseSandboxBlocked(run);
  if (isGreen && before !== null && committedTree(root) === before) writeFileSync(gitPath(root, STAMP), `${before}\n`);
  return { isGreen, isCached: false, output, seconds, log, profile, profilePath, receiptId, ...(run.timedOut ? { timedOut: true } : {}), environment: run.environment ?? null, ...(run.executionRoot ? { executionRoot: run.executionRoot } : {}),
    // A remote run's host load and pinned main reach the flake diagnostics with it (#925).
    ...(run.executionRunner ? { executionRunner: run.executionRunner, executionMain: run.executionMain ?? null, executionLoad: run.executionLoad ?? null } : {}), ...(stages ? { stages: run.stages } : {}) };
}

/**
 * The record one real gate run leaves for health: its result, and the positive control's result when the project
 * declares one. The control runs under the gate's own lease, so a child that runs the gate again inherits the
 * admission it already holds instead of asking for another slot (U41). Its raw output and profile stay in the
 * gate evidence, next to the gate's own.
 *
 * @param {string} root
 * @param {{ gate: string, positiveControl?: string }} config
 * @param {boolean} isGreen whether the gate itself passed
 * @param {object} [gateLease] the lease the gate runs under
 * @returns {{ at: string, green: boolean, control: boolean | null, gate: string, positiveControl: string | null, controlLog?: string, controlProfile?: string }}
 */
function gateRunRecord(root, config, isGreen, gateLease) {
  const at = new Date().toISOString();
  const environment = gateLease?.environment ?? null;
  const positiveControl = config.positiveControl?.trim() ? config.positiveControl : null;
  if (!positiveControl) return { at, green: isGreen, control: null, gate: config.gate, positiveControl, environment };
  const control = runProfiledShell(root, positiveControl, { gateLease, artifactPrefix: 'pullboard-gate-control', persistLog: true });
  // A control the environment refused says nothing about the gate, the same rule that keeps a refused gate run out of the record.
  const result = control.sandboxBlocked ? null : control.isGreen;
  return { at, green: isGreen, control: result, gate: config.gate, positiveControl, environment, controlLog: control.logPath, controlProfile: control.profilePath };
}

/** Quote a fixed executable or selected path without permitting shell expansion. */
function commandWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Run the project's declared static guard before proof, retaining normal queue classification. */
export async function runStaticChecks(root, config, { agent, item = '', onWait, onBrowserFallback } = {}) {
  const command = config.staticChecks?.trim();
  if (!command) return null;
  const browser = !browserFreeChecksEnabled() || await checkNeedsBrowser(root, command, { onFallback: onBrowserFallback });
  return withGateSlot(root, lease => {
    const run = runProfiledShell(root, command, { waitMs: lease.waitMs, artifactPrefix: 'pullboard-static-checks', persistLog: true, gateLease: lease });
    refuseSandboxBlocked(run);
    if (!run.isGreen) throw new Refused('GATE_RED', `static checks are red; fix the named source before running proof:\n${digestOf(run.output)}`);
    return run;
  }, { browser, gui: await checkNeedsGui(root, command), agent, item, kind: 'static', itemCheck: true, shortEligible: true, onWait });
}

/**
 * Prove the frozen item check and selected imports under one lease. Subsets neither read nor write
 * the full-gate stamp. An uncertain selection runs the full configured gate and records its reason.
 *
 * @param {string} root
 * @param {any} config
 * @param {{base:string|null, trunk?:string, changed?:string[], check:string, agent?:string, item?:string|number, kind?:string, onWait?:(state:object)=>void, onBrowserFallback?:(decision:{file:string,reason:string})=>void}} options
 * @returns {Promise<any>}
 */
export async function runSubmitGate(root, config, { base, trunk, changed, check, agent, item = '', kind = 'submit', onWait, onBrowserFallback, onFailure }) {
  if (!config.gate.trim()) throw missingGate(root);
  await runStaticChecks(root, config, { agent, item, onWait, onBrowserFallback });
  const selection = config.affectedTests
    ? selectAffectedTests(root, { base, trunk, changed })
    : { full: true, reason: 'affected-test selection is not enabled for this project', files: [] };
  const deferred = config.submitGate === 'landing';
  const deferFullFallback = deferred && selection.full;
  // A selection over submitDeferAbove files moves to the landing gate, which runs every recorded file before the item lands.
  const deferSelection = deferred && !selection.full && Number.isSafeInteger(config.submitDeferAbove) && selection.files.length > config.submitDeferAbove;
  const invariants = deferred ? [...new Set(config.submitInvariants ?? [])].sort() : [];
  const registryGuards = selectRegistryGuards(root, config.registryGuards, { base, trunk, changed });
  if (invariants.length && !config.affectedTests?.trim()) {
    throw new Refused('BAD_CONFIG', 'submitInvariants requires the project affectedTests runner');
  }
  for (const path of [...invariants, ...registryGuards]) {
    let file = false;
    try { file = statSync(join(root, path)).isFile(); } catch { /* Missing or unreadable invariants refuse rather than silently disappearing. */ }
    if (!file) throw new Refused('BAD_CONFIG', `${invariants.includes(path) ? 'submitInvariants' : 'registryGuards'} file ${path} is missing or unreadable; restore it or update the list on accepted main`);
  }
  const proofFiles = [...new Set([...(deferFullFallback || deferSelection ? [] : selection.files), ...invariants, ...registryGuards])].sort();
  const guardCommand = registryGuards.length ? `${config.affectedTests.trimEnd()} ${registryGuards.map(path => commandWord('./' + path)).join(' ')}` : '';
  const fullConfig = guardCommand ? { ...config, gate: `(${config.gate}) && ${guardCommand}` } : config;
  const allowBrowserFreeChecks = browserFreeChecksEnabled();
  const checkUsesBrowser = check ? (!allowBrowserFreeChecks || await checkNeedsBrowser(root, check, { onFallback: onBrowserFallback })) : false;
  const proofUsesBrowser = deferFullFallback || deferSelection
    ? (proofFiles.length > 0 && (!allowBrowserFreeChecks || await testsNeedBrowser(root, proofFiles, { onFallback: onBrowserFallback })))
    : (selection.full || !allowBrowserFreeChecks || await testsNeedBrowser(root, proofFiles, { onFallback: onBrowserFallback }));
  const browser = checkUsesBrowser || proofUsesBrowser;
  const gui = (check ? await checkNeedsGui(root, check) : false)
    || ((selection.full && !deferFullFallback && !deferSelection) && projectNeedsGui(root)) || testsNeedGui(root, proofFiles);
  return await withGateSlot(root, async (lease) => {
    pinRunMain(lease, onFailure);
    const startedAt = Date.now();
    const log = gitPath(root, 'pullboard-submit.log');
    const checkLog = `${log}.check.log`;
    const proofLog = `${log}.proof.log`;
    const criterion = check ? runProfiledShell(root, check, {
      waitMs: lease.waitMs, profileFile: `${checkLog}.profile.json`, gateLease: lease,
    }) : { isGreen: true, output: '', seconds: 0 };
    if (check) writeFileSync(checkLog, safeLog(criterion.output), { mode: 0o600 });
    const receipt = { command: check, green: criterion.isGreen, seconds: criterion.seconds, checked: Boolean(check),
      ...(check ? { log: checkLog, profilePath: criterion.profilePath, profile: criterion.profile } : {}) };
    /** Persist the whole submission's wall time and queue wait once, alongside its combined raw log. */
    const finish = (proof) => {
      const profilePath = `${log}.profile.json`;
      const profiles = [criterion.profile, proof.profile].filter(Boolean);
      const profile = writeTimingProfile(profilePath, {
        waitMs: lease.waitMs, wallMs: Math.max(0, Date.now() - startedAt),
        files: profiles.flatMap(value => value.files), tests: profiles.flatMap(value => value.tests),
        runner: [...new Set(profiles.map(value => value.runner))].join(', '),
        format: [...new Set(profiles.map(value => value.format))].join('+'),
        unavailable: profiles.some(value => value.unavailable) ? 'per-test timing unavailable: output was not TAP or JUnit (one or more phases)' : null,
        ...(lease.runner ? { executionRunner: lease.runner.host,
          executionSource: profiles.find(value => value.executionSource)?.executionSource } : {}),
      });
      refuseSandboxBlocked(proof);
      return { ...proof, log, seconds: criterion.seconds + proof.seconds, ...selection, files: proofFiles, registryGuards, ...(deferred ? { submitInvariants: invariants } : {}),
        ...(deferSelection ? { deferredFiles: selection.files, deferAbove: config.submitDeferAbove } : {}), deferred, deferFullFallback, check: receipt,
        profile, profilePath, proofProfilePath: proof.profilePath, proofLog: proof.log };
    };
    if (!criterion.isGreen) {
      writeFileSync(log, criterion.output);
      if (onFailure) await onFailure({ ...criterion, log: checkLog }, { root, command: check, lease });
      return finish({ isGreen: false, sandboxBlocked: criterion.sandboxBlocked, isCached: false, output: criterion.output, seconds: 0, log: '' });
    }
    // The proof already owns this lease: its phase profile has no additional queue wait.
    const proofWait = check ? 0 : lease.waitMs;
    let proof;
    // The proof keeps each stage's status, so a person's waiver can only ever explain named test failures.
    if (!deferFullFallback && selection.full) proof = fullGateRun(root, fullConfig, false, { waitMs: proofWait, log: proofLog, gateLease: lease, stages: true, kind: 'submit' });
    else if (!proofFiles.length) proof = { isGreen: true, output: '', seconds: 0, isCached: false, log: '' };
    else {
      const command = `${config.affectedTests.trimEnd()} ${proofFiles.map(path => commandWord('./' + path)).join(' ')}`;
      proof = { ...runProfiledShell(root, command, { waitMs: proofWait, profileFile: `${proofLog}.profile.json`, gateLease: lease, stages: true }), isCached: false, log: proofLog };
      writeFileSync(proofLog, proof.output);
    }
    const phase = deferFullFallback || deferSelection
      ? `submit invariants: ${invariants.length ? invariants.join(', ') : 'none'}; ${deferSelection ? `${selection.files.length} affected test files` : 'full suite'} deferred to the landing gate`
      : selection.full ? 'full gate' : 'affected tests';
    writeFileSync(log, `item check:\n${criterion.output}\n${phase}:\n${proof.output}`);
    if (!proof.isGreen && onFailure) await onFailure(proof, { root,
      command: !deferFullFallback && selection.full ? fullConfig.gate : `${config.affectedTests.trimEnd()} ${proofFiles.map(path => commandWord('./' + path)).join(' ')}`, lease });
    await recordRun(onFailure, proof);
    return finish(proof);
  }, { browser, gui, agent, item, kind, itemCheck: true, onWait });
}

/** The durable words a submission and its reviewers read for an affected selection moved to the landing gate. */
export function deferredSelectionNote(files) {
  return `${files.length} affected test files deferred to the landing gate`;
}

/** Describe precisely which submission proof ran, including absent checks and full fallbacks. */
export function submitGateReport(gate) {
  const registry = gate.registryGuards?.length ? `; registry guards: ${gate.registryGuards.join(', ')}` : '';
  const check = (gate.check.checked ? `item check ${gate.check.green ? 'green' : 'red'} in ${gate.check.seconds}s` : 'no item check') + registry;
  if (gate.deferred) {
    const reason = gate.reason ? `: ${gate.reason}` : '';
    const timings = timingDigest(gate.profile);
    const detail = timings ? `\n${timings}\ntiming profile: ${gate.profilePath}` : '';
    const invariantsOnly = gate.deferFullFallback || Boolean(gate.deferredFiles);
    const invariants = gate.submitInvariants?.length ? 'submit invariants: ' + gate.submitInvariants.join(', ') + '; ' : '';
    const proof = gate.deferFullFallback
      ? `${invariants}full suite deferred to the landing gate${reason}`
      : gate.deferredFiles
        ? `${invariants}${deferredSelectionNote(gate.deferredFiles)} (over submitDeferAbove ${gate.deferAbove}): ${gate.deferredFiles.join(', ')}`
        : `affected tests: ${gate.files.length ? gate.files.join(', ') : 'none'}; full suite deferred to the landing gate${gate.submitInvariants?.length ? '; submit invariants: ' + gate.submitInvariants.join(', ') : ''}`;
    const label = invariantsOnly ? (gate.registryGuards?.length ? 'submit invariants and registry guards' : 'submit invariants') : 'affected tests';
    const result = invariantsOnly && !gate.submitInvariants?.length && !gate.registryGuards?.length ? '' : `; ${gate.isGreen ? `${label} green in ${gate.seconds}s` : gateReport(gate)}`;
    return `${check}; ${proof}${result}${detail}`;
  }
  const selection = gate.full ? `full gate: ${gate.reason}` : `affected tests: ${gate.files.length ? gate.files.join(', ') : 'none'}`;
  const timings = timingDigest(gate.profile);
  const detail = timings ? `\n${timings}\ntiming profile: ${gate.profilePath}` : '';
  const result = gate.isGreen && !gate.full ? `affected tests green in ${gate.seconds}s${detail}` : gateReport(gate);
  return `${check}; ${selection}; ${result}`;
}

/** Show wall and queue wait for every run; rank files only when their durations were printed. */
export function timingDigest(profile) {
  if (!profile) return '';
  const measured = value => Number.isFinite(value) ? `${(value / 1000).toFixed(2)}s` : 'unavailable';
  const summary = `timing (${profile.runner ?? 'shell'}${profile.executionRunner ? ` on runner ${profile.executionRunner}` : ''}): wall ${measured(profile.wallMs)}, slot wait ${measured(profile.waitMs)}`;
  const rows = [...(profile.files ?? [])].filter(file => typeof file.path === 'string' && Number.isFinite(file.durationMs) && file.durationMs >= 0).sort((left, right) => right.durationMs - left.durationMs).slice(0, 10);
  const files = rows.length ? `\nslowest test files:\n${rows.map(file => `  ${file.path}: ${(file.durationMs / 1000).toFixed(2)}s`).join('\n')}` : '';
  const receipt = profile.receipt ? `\n${receiptLine(profile.receipt)}` : '';
  return `${summary}${receipt}${profile.unavailable ? `\n${profile.unavailable}` : ''}${files}`;
}

/**
 * What an agent sees of a gate run (V10): one line when green; when red, the digest and where the
 * whole output is.
 *
 * @param {{ isGreen: boolean, isCached: boolean, output: string, seconds: number, log: string, profile?: object, profilePath?: string }} gate
 * @returns {string}
 */
export function gateReport(gate) {
  const timings = timingDigest(gate.profile);
  const profilePath = timings && gate.profilePath ? `\ntiming profile: ${gate.profilePath}` : '';
  if (gate.isGreen) {
    const summary = gate.isCached ? 'gate green (this tree already passed)' : `gate green in ${gate.seconds}s`;
    if (!gate.profile?.files?.length) return timings ? `${summary}; ${timings.replaceAll('\n', '; ')}${gate.profilePath ? `; timing profile: ${gate.profilePath}` : ''}` : summary;
    return `${summary}\n${timings}${profilePath}`;
  }
  return `gate red in ${gate.seconds}s:\n${(digestOf(gate.output) || '(gate produced no output)').replace(/^/gm, '  ')}\n${timings ? `${timings}\n` : ''}the whole output is in ${gate.log}${profilePath}`;
}
