import { mainCheckout } from '../../../../src/git.js';
import { probe as transportProbe } from '../../../transport/index.js';
import { sourcePreparationFields } from '../../core.js';
/** Machine admission and receipts without eagerly loading board or full proof execution [Q1,Q2,Q3,C7]. */
import { Refused } from '../../../kernel/index.js';
import { recordRunnerMeasurement } from '../../../config/index.js';
import { declaredMachineSlots } from '../../../config/index.js';
import { machineHome } from '../../../resources/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  confirmRunnerProbe,
  inheritedGateSlot,
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
  slotOf,
  startReceipt,
} from './gate-receipt.js';
import {
  RunnerDropped,
  runnerSource,
} from '../core/gate-policy-load.js';

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

/** Snapshot required canonical operations before admission; functions remain private process-local lease state. */
export function requireGateExecutionServices(value) {
  const runners = ['sampleRunnerLoad', 'localRunnerDescriptor', 'carriedRunnerTrunk', 'probeRunnerTransport', 'probeRunnerHealth', 'runOnRunner', 'runOnRunnerAsync', 'effectiveRunners', 'refreshRunnerMeasurements'];
  const landing = ['captureReleaseQueue', 'constrainedLandingHost', 'releaseExecutors'];
  if (!runners.every(name => typeof value?.runners?.[name] === 'function')
    || !landing.every(name => typeof value?.landing?.[name] === 'function')) {
    throw new TypeError('gate execution needs explicit canonical runner and landing services');
  }
  return Object.freeze({ runners: Object.freeze(Object.fromEntries(runners.map(name => [name, value.runners[name]]))),
    landing: Object.freeze(Object.fromEntries(landing.map(name => [name, value.landing[name]]))) });
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
  return lease.receipt;
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
 * @param {{ landing?: boolean, itemCheck?: boolean, shortEligible?: boolean, diagnostic?: boolean, browser?: boolean, gui?: boolean, remote?: boolean, requiredExecutor?: {kind:'local'}|{kind:'ssh',host:string,hosts?:string[]}, runnerOnly?: boolean, runnerWaitMs?: number, runnerDeadlineAt?: number, timing?: boolean, agent?: string, item?: string|number, kind?: string, onWait?: (state: object) => void, onReceipt?: (receipt: object) => void, readMemory?: typeof readMachineMemory, pinnedSource?: {commit:string, tree:string, trunk:{ref:string, commit:string}} }} [options] - Queue class, short-slot eligibility, remote eligibility, progress reporter, the run's receipt once its slot is released (#836), for tests the machine memory reader, and an exact commit a runner takes from the object store in place of the checkout's HEAD (a main comparison, #3323).
 * @returns {Promise<any>} The action's result after releasing its lease.
 */
export async function withGateSlot(root, action, options = {}) {
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
    if (!['RUNNER_BROWSER_SLOT_REQUIRED', 'RUNNER_GUI_SESSION_REQUIRED'].includes(error?.code) || options.remote === false || options.runnerOnly || options.requiredExecutor?.kind === 'ssh') throw error;
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
    timingRunner: settings?.gate?.timingRunner ?? 'auto' };
}

/**
 * The capacity this machine's pool already records for a resource, or null. A runner's settings usually leave its slot
 * counts unset while its own jobs size the pool; a landing reshard inside such a job then asked for the default 2 against
 * the recorded 9 and stopped with RESOURCE_CAPACITY_MISMATCH (#2541).
 */
function recordedCapacity(name) {
  const file = join(machineHome(), 'resources.sqlite');
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
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
async function withOneGateSlot(root, action, { landing = false, itemCheck = false, shortEligible = false, diagnostic = false, browser = false, gui = false, remote = true, runnerOnly = false, runnerWaitMs, runnerDeadlineAt, requiredExecutor, timing = false, agent, item = '', kind = '', onWait, onReceipt, beforeAdmission, readMemory = readMachineMemory, executionServices, infrastructureRetry = false, signal, pinnedSource } = {}) {
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
  if (remote) await refreshRunnerMeasurements(settingsProvider(), { measure: probeRunnerTransport, record: recordRunnerMeasurement });
  const floorMB = memoryFloorMB();
  const capacityProvider = () => machineSlots(settingsProvider()).gate;
  // A pinned source is an exact commit read from the object store, so a runner may take it from a busy checkout [C7].
  const source = pinnedSource ? { commit: pinnedSource.commit, tree: pinnedSource.tree, pinned: true } : runnerSource(root);
  const retryInfrastructure = (infrastructureRetry || itemCheck || kind === 'review') && (itemCheck || kind === 'review');
  const avoided = AVOIDED_RUNNERS.getStore() ?? new Set();
  const infrastructureAttempts = [];
  const policyTrunk = pinnedSource ? pinnedSource.trunk : source ? mainCheckout(root) ?? carriedRunnerTrunk(root) : null;
  if (runnerOnly && (!remote || !source)) throw new Refused('RUNNER_SOURCE', 'Runner-only work needs a clean committed checkout for runner execution; commit the source and retry, with no local fallback');
  // Read the board once before queueing, never inside the machine admission transaction.
  const releaseContext = gateQueueSettings().currentReleaseFirst
    ? executionServices.landing.captureReleaseQueue(root, item) : undefined;
  tracker.mark('queuedAt');
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
    runnerProvider: () => preferOtherRunners(effectiveRunners(loadMachineSettings()), avoided),
    runnerLoadPolicyProvider: () => gateRunnerLoadPolicy(settingsProvider()),
    runnerHealthProbe: probeRunnerHealth,
    /** A cleanup or transport doubt is settled by the transport cell's probe: one good answer returns the runner (#3432). */
    runnerTransportProbe: transportProbe,
    /** Keep legacy fallback distinct from the ordinary exact-job health observation. */
    runnerIdleProbe: (runner, previous) => probeRunnerHealth(runner, previous, { idle: true }),
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
      if (remote && !state.admitted) await refreshRunnerMeasurements(settingsProvider(), { measure: probeRunnerTransport, record: recordRunnerMeasurement });
      return onWait?.(state);
    },
  });
  infrastructureAttempts.push(...(lease.infrastructureAttempts ?? []));
  tracker.mark('admittedAt');
  let healthyTransportRetry = false;
  try {
    while (true) {
      lease.source = source;
      lease.runMetadata = { landing, itemCheck, diagnostic, gui, timing, item: String(item), kind,
        ...(lease.runner && lease.token && lease.pool ? { resourceOwner: { token: lease.token, pool: lease.pool } } : {}),
        ...(policyTrunk?.commit ? { trunk: { ref: policyTrunk.branch ?? policyTrunk.ref, commit: policyTrunk.commit } } : {}) };
      timed(lease).tracker.mark('actionAt');
      try {
        const result = await action(lease);
        if (lease.runner && runnerOnly && (itemCheck || kind === 'review') && result?.timedOut === true) {
          throw new RunnerDropped(lease.runner.host, { reason: 'run-timeout' });
        }
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
        if (boundedRetry && infrastructureAttempts.length >= 1) {
          lease.infrastructureAttempts = [...infrastructureAttempts, failure];
          const refused = new Refused('RUNNER_INFRA_RETRY_EXHAUSTED', `runner ${lease.runner.host} failed again (${failure.code}) after the one automatic infrastructure retry; inspect the retained runner diagnostics before retrying`);
          refused.infrastructureAttempts = [...infrastructureAttempts, failure];
          throw refused;
        }
        infrastructureAttempts.push(failure);
        lease.infrastructureAttempts = [...infrastructureAttempts];
        // A separate Node process cannot prove that a worker which missed READY can accept a job.
        const admissionDeadline = !cleanup && (error.diagnostic?.reason === 'admission-deadline'
          || error.diagnostic?.phase !== 'ready' && Number.isSafeInteger(lease.runnerWaitDeadline) && Date.now() >= lease.runnerWaitDeadline);
        // A loaded runner gets 15 s and three retries before its failed call can quarantine it [C7].
        const health = cleanup || admissionDeadline || setup ? null : await confirmRunnerProbe(probeRunnerTransport, lease.runner);
        const diagnostic = { ...(error.diagnostic ?? { reason: error.name }), confirmingProbe: health };
        // A persistent receipt/capsule failure must surface; rotating through healthy hosts cannot repair it.
        if (health?.healthy && healthyTransportRetry) {
          const refused = new Refused('RUNNER_RESULT_INVALID', `runner ${lease.runner.host} answers SSH and Node but a second attempt lacks a valid completion (${diagnostic.reason}); inspect the retained transport diagnostic before retrying`);
          refused.runnerDiagnostic = diagnostic;
          throw refused;
        }
        if (health?.healthy) healthyTransportRetry = true;
        const runnerUnavailable = { host: lease.runner.host,
          reason: cleanup ? error.message : admissionDeadline ? 'worker did not become ready before its admission deadline'
            : setup ? error.message : health?.healthy ? 'transient failure; confirming SSH and Node observation succeeded' : 'failed call and confirming transport observation failed',
          diagnostic, until: cleanup ? 'the pinned worker verifies exact-job cleanup on its next health probe'
            : admissionDeadline ? 'the pinned worker proves readiness and exact-job cleanup on its next health probe'
              : health?.healthy ? 'the original ticket is readmitted' : 'the next successful automatic health observation' };
        if (onWait) await onWait({ holders: [], line: [], position: 0, runnerUnavailable });
        else process.stderr.write(`runner ${runnerUnavailable.host} unavailable: ${runnerUnavailable.reason}; until ${runnerUnavailable.until}; ${cleanup && !runnerOnly && restriction?.kind !== 'ssh' ? 'rerunning it locally' : 'requeueing the run'}\n`);
        try {
          lease = await lease.requeueRunner(cleanup ? 'cleanup-unverified' : admissionDeadline ? 'worker-unresponsive' : 'transport-lost', {
            local: cleanup && !runnerOnly && restriction?.kind !== 'ssh', quarantine: !health?.healthy, diagnostic,
            infrastructureRetryCount: boundedRetry ? infrastructureAttempts.length : 0,
            infrastructureAttempts: [...infrastructureAttempts] });
        } catch (requeueError) {
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
        lease.infrastructureAttempts = [...infrastructureAttempts];
      }
    }
  } finally {
    try { settleReceipt(lease); } finally { lease.release(); }
    record(lease);
  }
}

