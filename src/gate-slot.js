/** Machine admission and receipts without eagerly loading board or full proof execution [Q1,Q2,Q3,C7]. */
import { Refused } from './refused.js';
import {
  inheritedGateSlot,
  memoryAdmission,
  readMachineMemory,
  takeResource,
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
  localRunnerDescriptor,
  sampleRunnerLoad,
} from './runner-load.js';
import {
  recordReceipt,
  receiptOf,
  slotOf,
  startReceipt,
} from './gate-receipt.js';
import {
  RunnerDropped,
  runnerSource,
} from './runner-policy.js';

/** Close a gated run's receipt (#836) as its evidence is written; the slot's release records this same receipt. */
export function settleReceipt(lease) {
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

/** Run work under the machine queue: landings first, then every other eligible waiter in arrival order.
 * Local executors wait while this machine is out of memory; remote runners keep admitting.
 *
 * @param {string} root - Checkout used to locate the machine resource database.
 * shortEligible marks a run that names its test files: with gate.shortSlots above 0 it may take a
 * short slot when every ordinary slot is held, and a full suite can never inherit that slot. A memory
 * hold (gate.memoryFloorMB) holds short slots too, since a short run uses the same machine memory.
 *
 * @param {(lease: { waitMs: number, token?: string, pool?: string, browser?: boolean, slotClass?: 'gate'|'short', release: () => void }) => any | Promise<any>} action - Work to perform while holding a slot.
 * @param {{ landing?: boolean, itemCheck?: boolean, shortEligible?: boolean, diagnostic?: boolean, browser?: boolean, gui?: boolean, remote?: boolean, runnerOnly?: boolean, timing?: boolean, agent?: string, item?: string|number, kind?: string, onWait?: (state: object) => void, onReceipt?: (receipt: object) => void, readMemory?: typeof readMachineMemory }} [options] - Queue class, short-slot eligibility, remote eligibility, progress reporter, the run's receipt once its slot is released (#836) and, for tests, the machine memory reader.
 * @returns {Promise<any>} The action's result after releasing its lease.
 */
export async function withGateSlot(root, action, options = {}) {
  try { return await withOneGateSlot(root, action, options); }
  catch (error) {
    if (!['RUNNER_BROWSER_SLOT_REQUIRED', 'RUNNER_GUI_SESSION_REQUIRED'].includes(error?.code) || options.remote === false || options.runnerOnly) throw error;
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
async function withOneGateSlot(root, action, { landing = false, itemCheck = false, shortEligible = false, diagnostic = false, browser = false, gui = false, remote = true, runnerOnly = false, timing = false, agent, item = '', kind = '', onWait, onReceipt, readMemory = readMachineMemory } = {}) {
  const tracker = startReceipt();
  const receiptKind = kind || (landing ? 'landing' : 'gate');
  /** Hand the run its receipt tracker and slot, then record its receipt once the slot is released (#836). */
  const timed = lease => Object.assign(lease, { tracker, receiptKind,
    ...(!lease.runner ? { startLoad: lease.startLoad ?? sampleRunnerLoad(),
      localDescriptor: localRunnerDescriptor(lease.capacity ?? null, loadMachineSettings().browserSlots > 0) } : {}),
    slot: slotOf(lease, { browserFree: browserFreeChecksEnabled() }) });
  const record = lease => {
    const timing = lease.receipt ?? receiptOf(tracker, { kind: receiptKind, slot: lease.slot });
    const receipt = { ...timing, ...(lease.proofReceiptIds?.length ? { proofReceiptIds: [...lease.proofReceiptIds] } : {}) };
    recordReceipt(root, receipt);
    onReceipt?.(receipt);
  };
  const inherited = inheritedGateSlot({ root, browser, namedFiles: shortEligible, timing });
  if (inherited && (!runnerOnly || inherited.runnerExecution)) {
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
  if (runnerOnly && (!remote || !source)) throw new Refused('RUNNER_SOURCE', 'CPU-load tests need a clean committed checkout for runner execution; commit the source and retry, with no local fallback');
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
    runnerOnly,
    runnerProvider: () => loadMachineSettings().runners ?? [],
    runnersFirstProvider: gateRunnersFirstEnabled,
    runnerWaitMs: gateRunnerWaitMs(),
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
        else process.stderr.write(`runner ${runnerUnavailable.host} unavailable: ${runnerUnavailable.reason}; until ${runnerUnavailable.until}; ${cleanup && !runnerOnly ? 'rerunning it locally' : 'requeueing the run'}\n`);
        lease = await lease.requeueRunner(cleanup ? 'cleanup-unverified' : 'transport-lost', { local: cleanup && !runnerOnly });
      }
    }
  } finally {
    try { settleReceipt(lease); } finally { lease.release(); }
    record(lease);
  }
}

