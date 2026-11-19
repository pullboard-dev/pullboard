import { mainCheckout } from '../../../git/index.js';
import { probe as transportProbe } from '../../../transport/index.js';
import { sourcePreparationFields } from '../../light.js';
/** Machine admission and receipts without eagerly loading board or full proof execution [Q1,Q2,Q3,C7]. */
import { Refused } from '../../../kernel/index.js';
import { recordRunnerMeasurement } from '../../../config/index.js';
import { declaredMachineSlots } from '../../../config/index.js';
import { machineHome } from '../../../resources/index.js';
import { environmentAdapter } from '../../../env/index.js';
import { withEnvironment } from '../../../resources/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileSystemAdapter } from '../../../fs/index.js';
import { join } from 'node:path';
import {
  confirmRunnerProbe,
  gateSpanCause,
  inheritedGateSlot,
  recordGateSpan,
  memoryAdmission,
  readMachineMemory,
  takeResource,
  requiredExecutorOf,
} from '../../../resources/index.js';
import {
  browserFreeChecksEnabled,
  browserByLaunchEnabled,
  gateRunnersFirstEnabled,
  gateRunnerWaitMs,
  gateQueueSettings,
  gateShortSlots,
  loadMachineSettings,
  memoryFloorMB,
} from '../../../config/index.js';
import {
  recordReceipt,
  receiptOf,
  tripOverheadMs,
  slotOf,
  startReceipt,
} from './receipt.js';
import {
  RunnerDropped,
  runnerSource,
} from '../logic/policy.js';

const AVOIDED_RUNNERS = new AsyncLocalStorage();

/**
 * Run `work` with these runner hosts avoided by every gate admission inside it, and return its result. The set is
 * live: a host that fails during `work` joins it, so a requeue in the same scope also prefers another runner (#2516).
 */
export function withAvoidedRunners(hosts, work) {
  return AVOIDED_RUNNERS.run(hosts instanceof Set ? hosts : new Set(hosts), work);
}

/**
 * The runners an admission may use: every configured runner except avoided hosts, unless that leaves none.
 * Why: a failed host must not take the same candidate again while another runner can, but with no alternative the
 * run waits for the full pool (the failed host may recover) rather than for an empty one.
 */
export function preferOtherRunners(runners, avoided) {
  const others = runners.filter(runner => !avoided.has(runner.host));
  return others.length ? others : runners;
}

/** How long an infrastructure stop keeps retrying on other runners, in total from its first failure (#3365). */
export const INFRA_RETRY_WINDOW_MS = 30 * 60_000;
/**
 * The most infrastructure stops one gate takes: the stops the default schedule fits in the window (30, 60, 120, 240 s, then
 * 5 min waits, the last cut to the window's end, ten runs). Why: a zero or tiny back-off (fixtures set 0) made the
 * window the only bound, so a stuck pool retried for the whole 30 minutes of the clock instead of ending [C7].
 */
export const INFRA_RETRY_MAX_STOPS = 10;
/** The wait before the first infrastructure retry; it doubles with each stop up to INFRA_BACKOFF_MAX_MS (#3365). */
export const INFRA_BACKOFF_START_MS = 30_000;
/** The longest wait between two infrastructure retries (#3365). */
export const INFRA_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * The seconds to wait before the next infrastructure retry: 30 s, then 60 s, doubling to 5 min.
 *
 * @param {number} failures - Infrastructure stops already recorded before this one.
 * @param {{ startMs: number, maxMs: number }} policy
 * @returns {number} Milliseconds.
 */
export function infrastructureBackoffMs(failures, { startMs, maxMs }) {
  return Math.min(startMs * 2 ** Math.max(0, failures), maxMs);
}

/**
 * Fill in the infrastructure retry policy. PULLBOARD_INFRA_RETRY_BACKOFF_MS replaces the first wait (fixtures set 0).
 *
 * @param {{ windowMs?: number, startMs?: number, maxMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number }} [given]
 * @returns {{ windowMs: number, startMs: number, maxMs: number, sleep: (ms: number) => Promise<void>, now: () => number }}
 */
export function infrastructureRetryPolicy(given = {}) {
  const fromEnv = environmentAdapter().get('PULLBOARD_INFRA_RETRY_BACKOFF_MS');
  const envMs = fromEnv !== undefined && fromEnv !== '' && Number.isFinite(Number(fromEnv)) && Number(fromEnv) >= 0 ? Number(fromEnv) : null;
  return { windowMs: given.windowMs ?? INFRA_RETRY_WINDOW_MS, startMs: given.startMs ?? envMs ?? INFRA_BACKOFF_START_MS,
    maxMs: given.maxMs ?? INFRA_BACKOFF_MAX_MS, sleep: given.sleep ?? (ms => new Promise(done => setTimeout(done, ms))), now: given.now ?? Date.now };
}

/**
 * The runners an infrastructure retry may use: ones not yet tried first; when every runner has been tried, only the
 * least recently tried one (#3365).
 *
 * @param {{ host: string }[]} runners
 * @param {Set<string>} avoided
 * @param {string[]} tried - Hosts this ticket has failed on, least recent first.
 * @returns {{ host: string }[]}
 */
export function rotateRunners(runners, avoided, tried) {
  const untried = runners.filter(runner => !avoided.has(runner.host) && !tried.includes(runner.host));
  if (untried.length || runners.length < 2) return untried.length ? untried : preferOtherRunners(runners, avoided);
  const rank = runner => (tried.includes(runner.host) ? tried.indexOf(runner.host) : -1);
  return [[...runners].sort((a, b) => rank(a) - rank(b))[0]];
}

/** Snapshot required canonical operations before admission; functions remain private process-local lease state. */
export function requireGateExecutionServices(value) {
  const runners = ['sampleRunnerLoad', 'localRunnerDescriptor', 'carriedRunnerTrunk', 'probeRunnerTransport', 'probeRunnerHealth', 'runOnRunnerAsync', 'effectiveRunners', 'refreshRunnerMeasurements'];
  const landing = ['captureReleaseQueue', 'constrainedLandingHost', 'releaseExecutors'];
  if (!runners.every(name => typeof value?.runners?.[name] === 'function')
    || !landing.every(name => typeof value?.landing?.[name] === 'function')) {
    throw new TypeError('gate execution needs explicit canonical runner and landing services');
  }
  return Object.freeze({ runners: Object.freeze(Object.fromEntries(runners.map(name => [name, value.runners[name]]))),
    landing: Object.freeze(Object.fromEntries(landing.map(name => [name, value.landing[name]]))) });
}

/**
 * The refusal for a run whose worker could not verify cleanup after the command had started (its READY came): the
 * tests left a process or handle running past their end. Null for any other failure, including a cleanup timeout
 * before READY or one whose custody is uncertain (an overflowed journal), which stay the runner's infrastructure and are retried. Why: #3301's shard hung, the worker could not
 * drain it, and the gate retried the same red on two runners for 39 minutes (9 Nov) [C7].
 *
 * @param {any} error
 * @param {string} host
 * @returns {Refused|null}
 */
export function testLeakRefusal(error, host) {
  if (!(error instanceof Refused) || error.code !== 'RUNNER_CLEANUP_TIMEOUT' || error.diagnostic?.phase !== 'ready') return null;
  // A leak needs proof of a leftover process. An overflowed or unreadable spawn journal makes the runner's custody uncertain: it
  // names the processes it is still waiting on but cannot prove any is the tests', so that stays the runner's infrastructure.
  const cleanup = error.diagnostic?.cleanup;
  if (!(cleanup?.processes?.length > 0) || cleanup.uncertain === true || cleanup.censusFailure === true) return null;
  const refused = new Refused('RUNNER_TEST_LEAK', `the tests ran on ${host} and left processes that did not exit within 30 seconds of the run (${error.message}); a test leaves a child process, server or open handle running: stop it in the test's cleanup, commit, and submit again`);
  refused.diagnostic = error.diagnostic;
  return refused;
}

/**
 * Record one phase of a gate run under its slot, from `start` until now, for the open gate's span telemetry [C7].
 * Why here: the slot already owns the gate's admission and retry spans, so its callers need no telemetry import.
 *
 * @param {string} phase
 * @param {number} start - Epoch milliseconds.
 */
export function recordSlotPhase(phase, start) {
  recordGateSpan({ phase, start, outcome: 'done' });
}

/** Close a gated run's receipt (#836) as its evidence is written; the slot's release records this same receipt. */
export function settleReceipt(lease) {
  if (!lease?.tracker) return undefined;
  const { localRunnerDescriptor, sampleRunnerLoad } = lease.executionServices.runners;
  const executor = lease.executionAdmission;
  const local = !lease.runner;
  const descriptor = local ? lease.localDescriptor ?? localRunnerDescriptor(lease.capacity ?? null, null)
    : { id: lease.runner.host, kind: 'ssh', slots: { current: executor?.slots ?? lease.runner.slots, limit: executor?.slots ?? lease.runner.slots, elastic: false },
      capabilities: { os: lease.environment?.platform ?? null, browser: lease.runner.browser > 0, gui: lease.gui ?? null } };
  const admittedAt = local ? lease.admittedAt ?? new Date(lease.tracker.marks.admittedAt ?? lease.tracker.marks.requestedAt).toISOString() : executor?.admittedAt ?? null;
  const finishedAt = local ? new Date().toISOString() : executor?.finishedAt ?? null;
  const load = local ? { start: lease.startLoad ?? sampleRunnerLoad(), end: sampleRunnerLoad() } : executor?.load ?? null;
  const sourcePreparation = sourcePreparationFields(lease.sourcePreparation);
  lease.receipt = { ...receiptOf(lease.tracker, { kind: lease.receiptKind, slot: lease.slot }), environment: lease.environment ?? null,
    runner: descriptor, admittedAt, finishedAt, timing: lease.timing === true, inherited: lease.inherited === true,
    ...(lease.timingOperation ? { timingOperation: lease.timingOperation } : {}),
    occupiedSlots: lease.timing ? descriptor.slots.current : 1, load,
    ...(lease.runner?.dispatch ? { runnerDispatch: lease.runner.dispatch } : {}),
    executionPhases: lease.executionPhases ?? null,
    ...(sourcePreparation ? { sourcePreparation } : {}),
    ...(lease.lateRunnerDispatch ? { lateRunnerDispatch: { ...lease.lateRunnerDispatch } } : {}),
    ...(lease.infrastructureAttempts?.length ? { infrastructureAttempts: [...lease.infrastructureAttempts] } : {}),
    ...(local ? lease.timingEvidence?.() ?? { exclusive: false, unfencedClients: [] }
      : { exclusive: executor?.exclusive === true, unfencedClients: executor?.unfencedClients ?? [] }) };
  // The trip's time outside tests, so the static stage and U151's capacity model read one number per receipt [C7].
  const overheadMs = tripOverheadMs(lease.receipt);
  if (overheadMs !== null) lease.receipt.tripOverheadMs = overheadMs;
  return lease.receipt;
}

/**
 * Whether this machine's settings say gate.runnersOnly: then no runner failure or refusal falls back to a local run.
 * Why: on 8 Nov 15 gates on one machine reran their tests locally after a runner refused them, at load 78 (#3898).
 *
 * @returns {boolean}
 */
function machineRunnersOnly() {
  try { return loadMachineSettings().gate?.runnersOnly === true; } catch { return false; }
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
 * @param {{ env?: Record<string,string>, landing?: boolean, itemCheck?: boolean, shortEligible?: boolean, diagnostic?: boolean, browser?: boolean, gui?: boolean, remote?: boolean, requiredExecutor?: {kind:'local'}|{kind:'ssh',host:string,hosts?:string[]}, runnerOnly?: boolean, runnerWaitMs?: number, runnerDeadlineAt?: number, timing?: boolean, agent?: string, item?: string|number, kind?: string, onWait?: (state: object) => void, onReceipt?: (receipt: object) => void, readMemory?: typeof readMachineMemory, pinnedSource?: {commit:string, tree:string, trunk:{ref:string, commit:string}} }} [options] - Queue class, short-slot eligibility, remote eligibility, progress reporter, the run's receipt once its slot is released (#836), for tests the machine memory reader, and an exact commit a runner takes from the object store in place of the checkout's HEAD (a main comparison, #3323).
 * @returns {Promise<any>} The action's result after releasing its lease.
 */
export async function withGateSlot(root, action, options = {}) {
  // options.env, when given, is process.env for the whole admission and the action; absent, nothing changes.
  return withEnvironment(options.env, () => withGateSlotIn(root, action, options));
}

/** withGateSlot under its environment. */
async function withGateSlotIn(root, action, options) {
  const remoteCheck = gateRunnersFirstEnabled() && (options.itemCheck === true || options.kind === 'review');
  options = { ...options, runnerOnly: options.runnerOnly === true || remoteCheck,
    executionServices: requireGateExecutionServices(options.executionServices) };
  // An awaited admission callback may own only unreferenced handles. Keep the gate alive until
  // it records a result or throws; its lease heartbeat deliberately does not keep Node running.
  const keepAlive = setInterval(() => {}, 1_000);
  try { return await withOneGateSlot(root, action, options); }
  catch (error) {
    if (remoteCheck && ['RUNNER_WAIT_DEADLINE', 'RUNNER_INFRA_RETRY_EXHAUSTED'].includes(error?.code)) {
      const attempts = error.infrastructureAttempts ?? (error.infrastructureAttempt ? [error.infrastructureAttempt] : []);
      const hosts = [...new Set(attempts.flatMap(attempt => [attempt.runner, ...(attempt.runners ?? []).map(runner => runner.host)]).filter(Boolean))];
      const refused = new Refused('RUNNER_UNAVAILABLE', `runner-first check has no available runner (${hosts.join(', ') || 'none admitted'}): ${error.message}`);
      refused.infrastructureAttempts = attempts;
      // The 30 minute window is spent: the queued gate must stop at once, never rerun the whole submit (#3365).
      if (error.code === 'RUNNER_INFRA_RETRY_EXHAUSTED') refused.infrastructureWindowSpent = true;
      throw refused;
    }
    if (error?.code === 'RUNNER_BROWSER_SLOT_REQUIRED' && options.remote !== false && !options.browser
      && (options.runnerOnly || options.requiredExecutor?.kind === 'ssh')) {
      const attempt = error.runnerAttempt ?? { host: '', exitCode: null, output: '' };
      process.stderr.write(`${error.message}; retrying on an eligible runner with a browser slot\n`);
      const result = await withOneGateSlot(root, action, { ...options, browser: true });
      if (result && typeof result === 'object') result.runnerAttempt = attempt;
      return result;
    }
    // On a gate.runnersOnly machine a runner's refusal never becomes a local rerun: the run ends and the gate requeues (#3898).
    if (!['RUNNER_BROWSER_SLOT_REQUIRED', 'RUNNER_GUI_SESSION_REQUIRED'].includes(error?.code) || options.remote === false || options.runnerOnly || options.requiredExecutor?.kind === 'ssh' || machineRunnersOnly()) throw error;
    // The runner's red attempt stays on record beside the local rerun.
    const attempt = error.runnerAttempt ?? { host: '', exitCode: null, output: '' };
    const required = error.code === 'RUNNER_GUI_SESSION_REQUIRED' ? 'a GUI session' : 'a browser slot';
    process.stderr.write(`${error.message}; its attempt (exit ${attempt.exitCode}):\n${attempt.output}${attempt.output.endsWith('\n') || !attempt.output ? '' : '\n'}rerunning it locally with ${required}\n`);
    const result = await withOneGateSlot(root, action, { ...options, remote: false, browser: true });
    if (result && typeof result === 'object') result.runnerAttempt = attempt;
    return result;
  }
  finally { clearInterval(keepAlive); }
}

/**
 * Whether this machine has a registered runner a gate run can go to, read from the machine settings.
 * Why: a check baseline goes to a runner whenever one exists, never to this machine (#2520).
 *
 * @param {{ runners: { effectiveRunners: (settings: object) => object[] } }} executionServices
 */
export function runnersRegistered(executionServices) {
  return executionServices.runners.effectiveRunners(loadMachineSettings()).length > 0;
}

/**
 * The gate's live-load dispatch policy (#2509): on when gate.loadAwareDispatch is on, and by default for any
 * fleet with a measured runner (its cores are known, so 1.5x cores means something); off only when set off.
 * refreshRunnerMeasurements reads the same rule, so the gate measures exactly what it dispatches by.
 */
export function gateRunnerLoadPolicy(settings) {
  const setting = settings?.gate?.loadAwareDispatch;
  const measured = (settings?.runners ?? []).some(runner => Number.isSafeInteger(runner?.cores));
  // One runner kept for timed checks (#2512): picked by measured headroom unless gate.timingRunner names one or is false.
  return { enabled: setting === true || setting !== false && measured, ceiling: settings?.gate?.runnerBusyCeiling ?? 90,
    timingRunner: settings?.gate?.timingRunner ?? 'auto', requiredToolchains: settings?.['runners.requiredToolchains'] ?? null };
}

/**
 * The capacity this machine's pool already records for a resource, or null. A runner's settings usually leave its slot
 * counts unset while its own jobs size the pool; a landing reshard inside such a job then asked for the default 2 against
 * the recorded 9 and stopped with RESOURCE_CAPACITY_MISMATCH (#2541).
 */
function recordedCapacity(name) {
  const file = join(machineHome(), 'resources.sqlite');
  if (!fileSystemAdapter().exists(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 2000'); // a WAL read waits only on recovery; never stall an admission for it [C7]
    const capacity = db.prepare('SELECT capacity FROM resource WHERE name = ?').get(name)?.capacity;
    return Number.isSafeInteger(capacity) && capacity > 0 ? capacity : null;
  } catch { return null; } finally { db.close(); }
}

/** Use a declared slot count, else the pool's recorded capacity, else the settings default. */
function machineSlots(settings) {
  const declared = declaredMachineSlots();
  return { gate: declared.gate ? settings.gateSlots : recordedCapacity('gate') ?? settings.gateSlots,
    browser: declared.browser ? settings.browserSlots : recordedCapacity('browser') ?? settings.browserSlots };
}

/** One gate admission and its action; withGateSlot may call it again for a local rerun. */
async function withOneGateSlot(root, action, { landing = false, itemCheck = false, shortEligible = false, diagnostic = false, browser = false, gui = false, remote = true, runnerOnly = false, runnerWaitMs, runnerDeadlineAt, requiredExecutor, timing = false, agent, item = '', kind = '', onWait, onReceipt, beforeAdmission, readMemory = readMachineMemory, executionServices, infrastructureRetry = false, signal, pinnedSource, infrastructurePolicy } = {}) {
  const browserByLaunch = browserByLaunchEnabled();
  const { localRunnerDescriptor, sampleRunnerLoad, carriedRunnerTrunk, probeRunnerTransport, probeRunnerHealth, effectiveRunners, refreshRunnerMeasurements } = executionServices.runners;
  const restriction = requiredExecutorOf(requiredExecutor);
  const tracker = startReceipt();
  const receiptKind = kind || (landing ? 'landing' : 'gate');
  /** Hand the run its receipt tracker and slot, then record its receipt once the slot is released (#836). */
  const timed = lease => {
    Object.defineProperty(lease, 'executionServices', { value: executionServices });
    return Object.assign(lease, { tracker, receiptKind, browserByLaunch, ...(signal ? { signal } : {}),
    ...(!lease.runner ? { startLoad: lease.startLoad ?? sampleRunnerLoad(),
      localDescriptor: localRunnerDescriptor(lease.capacity ?? null, loadMachineSettings().browserSlots > 0) } : {}),
    slot: slotOf(lease, { browserFree: browserFreeChecksEnabled() }) });
  };
  const record = lease => {
    const timing = lease.receipt ?? receiptOf(tracker, { kind: receiptKind, slot: lease.slot });
    const receipt = { ...timing, ...(lease.proofReceiptIds?.length ? { proofReceiptIds: [...lease.proofReceiptIds] } : {}) };
    recordReceipt(root, receipt);
    onReceipt?.(receipt);
  };
  const inherited = inheritedGateSlot({ root, browser, namedFiles: shortEligible, timing });
  if (inherited && restriction?.kind !== 'ssh' && !(restriction?.kind === 'local' && inherited.runnerExecution) && (!runnerOnly || inherited.runnerExecution)) {
    timed(Object.assign(inherited, { inherited: true }));
    try {
      await beforeAdmission?.();
      await onWait?.({ admitted: true });
      inherited.tracker.mark('actionAt');
      return await action(inherited);
    }
    finally {
      try { settleReceipt(inherited); } finally { inherited.release(); }
      record(inherited);
    }
  }
  const settingsProvider = () => loadMachineSettings();
  if (remote) await refreshRunnerMeasurements(settingsProvider(), { measure: probeRunnerTransport, record: recordRunnerMeasurement, probeDirectory: join(machineHome(), 'runner-probes') });
  const floorMB = memoryFloorMB();
  const capacityProvider = () => machineSlots(settingsProvider()).gate;
  // A pinned source is an exact commit read from the object store, so a runner may take it from a busy checkout [C7].
  const source = pinnedSource ? { commit: pinnedSource.commit, tree: pinnedSource.tree, pinned: true } : runnerSource(root);
  const retryInfrastructure = (infrastructureRetry || itemCheck || kind === 'review') && (itemCheck || kind === 'review');
  const avoided = AVOIDED_RUNNERS.getStore() ?? new Set();
  const infrastructureAttempts = [];
  const retryPolicy = infrastructureRetryPolicy(infrastructurePolicy);
  const triedRunners = [];
  let infrastructureStartedAt = null;
  const policyTrunk = pinnedSource ? pinnedSource.trunk : source ? mainCheckout(root) ?? carriedRunnerTrunk(root) : null;
  if (runnerOnly && (!remote || !source)) throw new Refused('RUNNER_SOURCE', 'Runner-only work needs a clean committed checkout for runner execution; commit the source and retry, with no local fallback');
  // Read the board once before queueing, never inside the machine admission transaction.
  const releaseContext = gateQueueSettings().currentReleaseFirst
    ? await executionServices.landing.captureReleaseQueue(root, item) : undefined;
  tracker.mark('queuedAt');
  const admissionStart = Date.now();
  let lease = await takeResource({
    name: 'gate',
    capacity: capacityProvider(),
    capacityProvider,
    shortCapacityProvider: () => gateShortSlots(),
    shortEligible,
    browserCapacityProvider: () => machineSlots(settingsProvider()).browser,
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
    infrastructureRetry: retryInfrastructure,
    allowIdleCapacityUpdate: true,
    allowCapacityGrowth: true,
    remote: remote && Boolean(source),
    runnerOnly,
    ...(restriction ? { requiredExecutor: restriction } : {}),
    runnerProvider: () => rotateRunners(effectiveRunners(loadMachineSettings()), avoided, triedRunners),
    runnerLoadPolicyProvider: () => gateRunnerLoadPolicy(settingsProvider()),
    runnerHealthProbe: probeRunnerHealth,
    /** A cleanup or transport doubt is settled by the transport cell's probe: one good answer returns the runner (#3432). */
    runnerTransportProbe: transportProbe,
    /** Keep legacy fallback distinct from the ordinary exact-job health observation. */
    runnerIdleProbe: (runner, previous, { liveJobs = [] } = {}) => probeRunnerHealth(runner, previous, { idle: true, liveJobs }),
    /** An idle runner's unresponsive worker is ended and proven idle again by the worker itself (#2035). */
    runnerRestartProbe: runner => probeRunnerHealth(runner, undefined, { restart: true }),
    /** A quarantined runner with no holders has leaked job processes stopped, then proves idle again (#2515). */
    runnerLeakProbe: (runner, { liveJobs = [] } = {}) => probeRunnerHealth(runner, undefined, { stopLeaked: true, liveJobs }),
    runnersFirstProvider: gateRunnersFirstEnabled,
    runnerWaitMs: runnerWaitMs ?? gateRunnerWaitMs(),
    runnerDeadlineAt,
    releaseContext,
    beforeAdmission,
    memory: floorMB === null ? undefined : memoryAdmission({ floorBytes: () => (memoryFloorMB() ?? floorMB) * 1024 ** 2, read: readMemory }),
    onWait: async state => {
      if (remote && !state.admitted) await refreshRunnerMeasurements(settingsProvider(), { measure: probeRunnerTransport, record: recordRunnerMeasurement, probeDirectory: join(machineHome(), 'runner-probes') });
      return onWait?.(state);
    },
  }).catch(error => {
    recordGateSpan({ phase: 'admission', start: admissionStart, outcome: 'failed', cause: gateSpanCause(error), code: error?.code, kind: receiptKind });
    throw error;
  });
  // The admission span: queued for a slot until one was granted, on its runner or this machine [C7].
  recordGateSpan({ phase: 'admission', start: admissionStart, host: lease.runner?.host, kind: receiptKind });
  infrastructureAttempts.push(...(lease.infrastructureAttempts ?? []));
  tracker.mark('admittedAt');
  let healthyTransportRetry = false;
  let healthyDeadlineRetry = false;
  // The host of the previous infrastructure stop: a healthy host failing twice in a row is a receipt fault; coming back to it after the others failed is rotation (#3365).
  let previousStopHost = null;
  try {
    while (true) {
      lease.source = source;
      lease.runMetadata = { landing, itemCheck, diagnostic, gui, timing, item: String(item), kind,
        ...(lease.runner && lease.token && lease.pool ? { resourceOwner: { token: lease.token, pool: lease.pool } } : {}),
        ...(policyTrunk?.commit ? { trunk: { ref: policyTrunk.branch ?? policyTrunk.ref, commit: policyTrunk.commit } } : {}) };
      timed(lease).tracker.mark('actionAt');
      try {
        // A timed-out run is the tests' red, recorded as it came back: retrying it elsewhere ran #3301's hang three
        // times, 13 minutes each (9 Nov) [C7].
        const result = await action(lease);
        if (infrastructureAttempts.length) {
          infrastructureAttempts.push({ kind: 'retry', code: null, runner: lease.runner?.host ?? 'local',
            outcome: result?.isGreen === false || result?.state === 'red' ? 'check-red' : 'completed', at: new Date().toISOString() });
          lease.infrastructureAttempts = [...infrastructureAttempts];
        }
        return result;
      }
      catch (error) {
        if (error instanceof Refused && error.code === 'RUNNER_SOURCE_CHANGED' && error.runnerCancellation?.version === 1) {
          if (lease.runner) {
            if (typeof lease.cancelRunner !== 'function') throw new Refused('RESOURCE_LEASE_LOST', 'source cancellation needs the owned remote lease cancellation operation');
            lease.cancelRunner(error.runnerCancellation);
          }
          throw error;
        }
        // Processes the tests left behind after they ran are the tests' red, not the runner's: never retried (#3301).
        if (lease.runner) {
          const leaked = testLeakRefusal(error, lease.runner.host);
          if (leaked) throw leaked;
        }
        // Unverified cleanup belongs to the runner; runner-only checks retain remote admission on retry.
        const setup = error instanceof Refused && error.code === 'RUNNER_SETUP';
        const cleanup = error instanceof Refused && ['RUNNER_CLEANUP_TIMEOUT', 'RUNNER_JOB_LOST', 'RUNNER_UNAVAILABLE'].includes(error.code);
        // A runner's own failure names its host and avoids it for the requeue, here and in a later whole-submit attempt.
        if (lease.runner && error && typeof error === 'object' && (error instanceof RunnerDropped || cleanup || setup || error.code === 'RUNNER_WAIT_DEADLINE')) {
          error.runnerHost ??= lease.runner.host;
          avoided.add(lease.runner.host);
        }
        const boundedRetry = retryInfrastructure || setup || ['RUNNER_JOB_LOST', 'RUNNER_UNAVAILABLE'].includes(error?.code)
          || infrastructureAttempts.some(attempt => ['RUNNER_JOB_LOST', 'RUNNER_UNAVAILABLE'].includes(attempt.code));
        if (!(error instanceof RunnerDropped || cleanup || setup) || !lease.runner || !lease.requeueRunner) {
          if (infrastructureAttempts.length) {
            infrastructureAttempts.push({ kind: 'retry', code: error?.code ?? error?.name ?? 'unknown', runner: lease.runner?.host ?? 'local',
              outcome: 'error', at: new Date().toISOString() });
            lease.infrastructureAttempts = [...infrastructureAttempts];
          }
          throw error;
        }
        const failure = { kind: cleanup ? 'cleanup-timeout' : setup ? 'runner-setup' : 'transport-lost', code: cleanup || setup ? error.code : error.code ?? 'TRANSPORT_LOST',
          runner: lease.runner.host, at: new Date().toISOString(), diagnostic: error.diagnostic ?? null };
        // Each stop rotates to a runner not yet tried, waits 30 s doubling to 5 min, and the window is 30 min from the first stop (#3365).
        infrastructureStartedAt ??= retryPolicy.now();
        triedRunners.splice(0, triedRunners.length, ...triedRunners.filter(host => host !== failure.runner), failure.runner);
        // The last wait is cut to the rest of the window, so the gate keeps retrying until the full 30 minutes have passed.
        const windowLeftMs = retryPolicy.windowMs - (retryPolicy.now() - infrastructureStartedAt);
        const waitMs = boundedRetry ? Math.max(0, Math.min(infrastructureBackoffMs(infrastructureAttempts.length, retryPolicy), windowLeftMs)) : 0;
        failure.waitedSeconds = waitMs / 1000;
        const priorStops = infrastructureAttempts.filter(attempt => ['cleanup-timeout', 'runner-setup', 'transport-lost'].includes(attempt.kind)).length;
        if (boundedRetry && (windowLeftMs <= 0 || priorStops + 1 >= INFRA_RETRY_MAX_STOPS)) {
          lease.infrastructureAttempts = [...infrastructureAttempts, failure];
          const refused = new Refused('RUNNER_INFRA_RETRY_EXHAUSTED', `runners ${triedRunners.join(', ')} all stopped on infrastructure through the ${Math.round(retryPolicy.windowMs / 60_000)}-minute retry window; the last code was ${failure.code} on ${failure.runner}; inspect the retained runner diagnostics before retrying`);
          refused.infrastructureAttempts = [...infrastructureAttempts, failure];
          throw refused;
        }
        infrastructureAttempts.push(failure);
        lease.infrastructureAttempts = [...infrastructureAttempts];
        // Only the dispatch's own READY timer names a missed READY: the lease's queue deadline passes during any long
        // phase, so reading the clock against it marked a plain transport loss as a readiness failure (#3563) [C7].
        const admissionDeadline = !cleanup && error.diagnostic?.reason === 'admission-deadline';
        // A loaded runner gets 15 s and three retries before its failed call can quarantine it [C7]. A missed admission
        // deadline gets the same probe (#3738): on 8 Nov a coordinator at load 25 missed every deadline and quarantined
        // six idle runners that all answered SSH; the deadline is the controller's clock, not the runner's answer.
        const health = cleanup || setup ? null : await confirmRunnerProbe(probeRunnerTransport, lease.runner, retryPolicy.startMs === 0 ? { pauseMs: 0, hostDownMs: 0 } : {}); // A zero first wait (fixtures) skips the confirming probe's pauses too, so a fast-failing stub cannot sit out the 21 s host-down window (#4575).
        const diagnostic = { ...(error.diagnostic ?? { reason: error.name }), confirmingProbe: health };
        // A persistent receipt/capsule failure must surface; rotating through healthy hosts cannot repair it.
        const repeatedStop = previousStopHost === lease.runner.host;
        previousStopHost = lease.runner.host;
        if (health?.healthy && !admissionDeadline && healthyTransportRetry && repeatedStop) {
          const refused = new Refused('RUNNER_RESULT_INVALID', `runner ${lease.runner.host} answers SSH and Node but a second attempt lacks a valid completion (${diagnostic.reason}); inspect the retained transport diagnostic before retrying`);
          refused.runnerDiagnostic = diagnostic;
          throw refused;
        }
        // An answering runner that misses READY twice leaves the runner in service and refuses only this job's wait.
        if (health?.healthy && admissionDeadline && healthyDeadlineRetry) {
          const refused = new Refused('RUNNER_WAIT_DEADLINE', `runner ${lease.runner.host} answers SSH and Node but missed its admission deadline again; the runner stays in service; check this machine's load, then retry`);
          refused.runnerDiagnostic = diagnostic;
          refused.infrastructureAttempts = [...infrastructureAttempts];
          throw refused;
        }
        if (health?.healthy) {
          if (admissionDeadline) healthyDeadlineRetry = true;
          else healthyTransportRetry = true;
        }
        const runnerUnavailable = { host: lease.runner.host,
          reason: cleanup ? error.message : admissionDeadline ? health?.healthy
            ? 'worker did not become ready before its admission deadline; confirming SSH and Node observation succeeded'
            : 'worker did not become ready before its admission deadline'
            : setup ? error.message : health?.healthy ? 'transient failure; confirming SSH and Node observation succeeded' : 'failed call and confirming transport observation failed',
          diagnostic, until: cleanup ? 'the pinned worker verifies exact-job cleanup on its next health probe'
            : health?.healthy ? 'the original ticket is readmitted'
              : admissionDeadline ? 'the pinned worker proves readiness and exact-job cleanup on its next health probe'
                : 'the next successful automatic health observation' };
        if (onWait) await onWait({ holders: [], line: [], position: 0, runnerUnavailable });
        else process.stderr.write(`runner ${runnerUnavailable.host} unavailable: ${runnerUnavailable.reason}; until ${runnerUnavailable.until}; ${cleanup && !runnerOnly && restriction?.kind !== 'ssh' ? 'rerunning it locally' : 'requeueing the run'}\n`);
        const retryStart = Date.now();
        if (waitMs > 0) await retryPolicy.sleep(waitMs);
        try {
          lease = await lease.requeueRunner(cleanup ? 'cleanup-unverified' : admissionDeadline ? 'worker-unresponsive' : 'transport-lost', {
            local: cleanup && !runnerOnly && restriction?.kind !== 'ssh', quarantine: !health?.healthy, diagnostic,
            infrastructureRetryCount: boundedRetry ? infrastructureAttempts.length : 0,
            infrastructureAttempts: [...infrastructureAttempts] });
        } catch (requeueError) {
          recordGateSpan({ phase: 'retry', start: retryStart, host: failure.runner, outcome: 'failed', cause: 'infra-retry', code: requeueError?.code, kind: receiptKind });
          const requeueAttempt = requeueError?.code === 'RUNNER_WAIT_DEADLINE'
            ? { kind: 'runner-wait', code: requeueError.code, runner: requeueError.infrastructureAttempt?.runners?.[0]?.host ?? null,
              runners: requeueError.infrastructureAttempt?.runners ?? [], at: new Date().toISOString(), message: requeueError.message }
            : null;
          const attempts = [...infrastructureAttempts, ...(requeueAttempt ? [requeueAttempt] : [])];
          if (attempts.length) requeueError.infrastructureAttempts = attempts;
          if (boundedRetry && requeueAttempt) {
            const refused = new Refused('RUNNER_INFRA_RETRY_EXHAUSTED', `runner ${failure.runner} failed (${failure.code}); its one queued retry then reached ${requeueError.code}: ${requeueError.message}`);
            refused.infrastructureAttempts = attempts;
            throw refused;
          }
          throw requeueError;
        }
        // The retry span: from the runner's stop through the backoff until the requeued run is admitted again.
        recordGateSpan({ phase: 'retry', start: retryStart, host: failure.runner, outcome: 'retry', cause: 'infra-retry', code: failure.code, kind: receiptKind });
        lease.infrastructureAttempts = [...infrastructureAttempts];
      }
    }
  } finally {
    try { settleReceipt(lease); } finally { lease.release(); }
    record(lease);
  }
}

