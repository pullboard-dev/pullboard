import { mainCheckout } from './git.js';
import { sourcePreparationFields } from './runner-overhead.js';
/** Machine admission and receipts without eagerly loading board or full proof execution [Q1,Q2,Q3,C7]. */
import { Refused } from './refused.js';
import {
  inheritedGateSlot,
  memoryAdmission,
  readMachineMemory,
  takeResource,
  requiredExecutorOf,
} from './resources.js';
import {
  browserFreeChecksEnabled,
  gateRunnersFirstEnabled,
  gateRunnerWaitMs,
  gateQueueSettings,
  gateShortSlots,
  loadMachineSettings,
  memoryFloorMB,
} from './settings.js';
import {
  recordReceipt,
  receiptOf,
  slotOf,
  startReceipt,
} from './gate-receipt.js';
import {
  RunnerDropped,
  runnerSource,
} from './gate-policy-load.js';

/** Snapshot required canonical operations before admission; functions remain private process-local lease state. */
export function requireGateExecutionServices(value) {
  const runners = ['sampleRunnerLoad', 'localRunnerDescriptor', 'carriedRunnerTrunk', 'probeRunnerTransport', 'probeRunnerHealth', 'runOnRunner', 'runOnRunnerAsync'];
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
    occupiedSlots: lease.timing ? descriptor.slots.current : 1, load,
    executionPhases: lease.executionPhases ?? null,
    ...(sourcePreparation ? { sourcePreparation } : {}),
    ...(lease.lateRunnerDispatch ? { lateRunnerDispatch: { ...lease.lateRunnerDispatch } } : {}),
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
 * @param {{ landing?: boolean, itemCheck?: boolean, shortEligible?: boolean, diagnostic?: boolean, browser?: boolean, gui?: boolean, remote?: boolean, requiredExecutor?: {kind:'local'}|{kind:'ssh',host:string}, runnerOnly?: boolean, runnerWaitMs?: number, runnerDeadlineAt?: number, timing?: boolean, agent?: string, item?: string|number, kind?: string, onWait?: (state: object) => void, onReceipt?: (receipt: object) => void, readMemory?: typeof readMachineMemory }} [options] - Queue class, short-slot eligibility, remote eligibility, progress reporter, the run's receipt once its slot is released (#836) and, for tests, the machine memory reader.
 * @returns {Promise<any>} The action's result after releasing its lease.
 */
export async function withGateSlot(root, action, options = {}) {
  options = { ...options, executionServices: requireGateExecutionServices(options.executionServices) };
  try { return await withOneGateSlot(root, action, options); }
  catch (error) {
    if (!['RUNNER_BROWSER_SLOT_REQUIRED', 'RUNNER_GUI_SESSION_REQUIRED'].includes(error?.code) || options.remote === false || options.runnerOnly || options.requiredExecutor?.kind === 'ssh') throw error;
    // The runner's red attempt stays on record beside the local rerun.
    const attempt = error.runnerAttempt ?? { host: '', exitCode: null, output: '' };
    const required = error.code === 'RUNNER_GUI_SESSION_REQUIRED' ? 'a GUI session' : 'a browser slot';
    process.stderr.write(`${error.message}; its attempt (exit ${attempt.exitCode}):\n${attempt.output}${attempt.output.endsWith('\n') || !attempt.output ? '' : '\n'}rerunning it locally with ${required}\n`);
    const result = await withOneGateSlot(root, action, { ...options, remote: false, browser: true });
    if (result && typeof result === 'object') result.runnerAttempt = attempt;
    return result;
  }
}

/** One gate admission and its action; withGateSlot may call it again for a local rerun. */
async function withOneGateSlot(root, action, { landing = false, itemCheck = false, shortEligible = false, diagnostic = false, browser = false, gui = false, remote = true, runnerOnly = false, runnerWaitMs, runnerDeadlineAt, requiredExecutor, timing = false, agent, item = '', kind = '', onWait, onReceipt, readMemory = readMachineMemory, executionServices } = {}) {
  const { localRunnerDescriptor, sampleRunnerLoad, carriedRunnerTrunk, probeRunnerTransport, probeRunnerHealth } = executionServices.runners;
  const restriction = requiredExecutorOf(requiredExecutor);
  const tracker = startReceipt();
  const receiptKind = kind || (landing ? 'landing' : 'gate');
  /** Hand the run its receipt tracker and slot, then record its receipt once the slot is released (#836). */
  const timed = lease => {
    Object.defineProperty(lease, 'executionServices', { value: executionServices });
    return Object.assign(lease, { tracker, receiptKind,
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
  const floorMB = memoryFloorMB();
  const capacityProvider = () => settingsProvider().gateSlots;
  const source = runnerSource(root);
  const policyTrunk = source ? mainCheckout(root) ?? carriedRunnerTrunk(root) : null;
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
    runnerOnly,
    ...(restriction ? { requiredExecutor: restriction } : {}),
    runnerProvider: () => loadMachineSettings().runners ?? [],
    runnerHealthProbe: probeRunnerHealth,
    /** Keep legacy fallback distinct from the ordinary exact-job health observation. */
    runnerIdleProbe: runner => probeRunnerHealth(runner, undefined, { idle: true }),
    runnersFirstProvider: gateRunnersFirstEnabled,
    runnerWaitMs: runnerWaitMs ?? gateRunnerWaitMs(),
    runnerDeadlineAt,
    releaseContext,
    memory: floorMB === null ? undefined : memoryAdmission({ floorBytes: () => (memoryFloorMB() ?? floorMB) * 1024 ** 2, read: readMemory }),
    onWait,
  });
  tracker.mark('admittedAt');
  let healthyTransportRetry = false;
  try {
    while (true) {
      lease.source = source;
      lease.runMetadata = { landing, itemCheck, diagnostic, gui, timing, item: String(item), kind,
        ...(policyTrunk?.commit ? { trunk: { ref: policyTrunk.branch ?? policyTrunk.ref, commit: policyTrunk.commit } } : {}) };
      timed(lease).tracker.mark('actionAt');
      try { return await action(lease); }
      catch (error) {
        // A cleanup the runner could not verify is the runner's failure, not the run's: rerun it locally (#1063).
        const cleanup = error instanceof Refused && error.code === 'RUNNER_CLEANUP_TIMEOUT';
        if (!(error instanceof RunnerDropped || cleanup) || !lease.runner || !lease.requeueRunner) throw error;
        // A separate Node process cannot prove that a worker which missed READY can accept a job.
        const admissionDeadline = !cleanup && (error.diagnostic?.reason === 'admission-deadline'
          || error.diagnostic?.phase !== 'ready' && Number.isSafeInteger(lease.runnerWaitDeadline) && Date.now() >= lease.runnerWaitDeadline);
        const health = cleanup || admissionDeadline ? null : await probeRunnerTransport(lease.runner);
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
            : health.healthy ? 'transient failure; confirming SSH and Node observation succeeded' : 'failed call and confirming transport observation failed',
          diagnostic, until: cleanup ? 'the pinned worker verifies exact-job cleanup on its next health probe'
            : admissionDeadline ? 'the pinned worker proves readiness and exact-job cleanup on its next health probe'
              : health.healthy ? 'the original ticket is readmitted' : 'the next successful automatic health observation' };
        if (onWait) await onWait({ holders: [], line: [], position: 0, runnerUnavailable });
        else process.stderr.write(`runner ${runnerUnavailable.host} unavailable: ${runnerUnavailable.reason}; until ${runnerUnavailable.until}; ${cleanup && !runnerOnly && restriction?.kind !== 'ssh' ? 'rerunning it locally' : 'requeueing the run'}\n`);
        lease = await lease.requeueRunner(cleanup ? 'cleanup-unverified' : admissionDeadline ? 'worker-unresponsive' : 'transport-lost', {
          local: cleanup && !runnerOnly && restriction?.kind !== 'ssh', quarantine: !health?.healthy, diagnostic });
      }
    }
  } finally {
    try { settleReceipt(lease); } finally { lease.release(); }
    record(lease);
  }
}

