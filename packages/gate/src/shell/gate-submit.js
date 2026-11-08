import { submitReusePlanDigest } from '../../../verify/index.js';
import { countTrialGate } from './refusal-trial.js';
import { runMachineryGuard } from './refusal-trial.js';
import { requireTestTierAccount } from './test-tier-selection.js';
import { selectTestTiers } from './test-tier-selection.js';
import { testTierProofFiles } from './test-tier-selection.js';
import { testTierReport } from './test-tier-selection.js';
import { requireSealedSkips } from './test-tier-selection.js';
import { startReceipt } from './gate-receipt.js';
import { dirname } from 'node:path';
/** Concern-specific gate stage; public callers keep the gate facade. */
import { testOutcomeFields } from './test-outcomes.js';
import { sourceAdvancePlan } from '../../../codemap/index.js';
import {
  withGateSlot,
} from './gate-slot.js';
import {
  mappedCheck,
} from '../../../codemap/index.js';
import {
  placementSubmitSelection,
} from './test-placement.js';
import {
  checkNeedsGui,
  projectNeedsGui,
  testsNeedGui,
} from './gui-admission.js';
import {
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  git,
  gitPath,
} from '../../../../src/git.js';
import {
  Refused,
} from '../../../kernel/index.js';
import {
  missingGate,
} from './gate-config.js';
import { contains } from '../../../../src/git.js';
import { mainPolicy } from '../../../sandbox/index.js';
import {
  browserFreeChecksEnabled,
  loadMachineSettings,
} from '../../../config/index.js';
import {
  selectAffectedTests,
  selectTestTreeGuards,
} from './affected-tests.js';
import {
  selectRegistryGuards,
} from '../../../kernel/index.js';
import {
  checkNeedsBrowser,
  testsNeedBrowser,
} from './browser-admission.js';
import {
  writeTimingProfile,
} from './gate-output.js';
import {
  fullGateRunAsync,
  pinRunMain,
  recordRun,
  refuseSandboxBlocked,
  runProfiledShardsAsync,
  runProfiledShellAsync,
  safeLog,
} from './gate-execution.js';
import { shardSlotOptions } from './proof-shards.js';
import { freeRunnerSlots } from './proof-shards.js';
import { proveBatches } from './proof-shards.js';
import { readFileTimes } from './test-value-timing.js';
import {
  commandWord,
  runStaticChecks,
} from './gate-static-check.js';
/** Freeze submission execution policy with the same accepted-main floors at every origin and run. */
export function submitGateConfig(config, accepted) {
  return { ...config, gate: config.gate.trim() ? config.gate : accepted.gate, submitGate: accepted.submitGate, staticChecks: accepted.staticChecks,
    submitInvariants: accepted.submitInvariants, submitDeferAbove: accepted.submitDeferAbove,
    registryGuards: accepted.registryGuards,
    ...(accepted.submitInvariants.length || accepted.registryGuards.length ? { affectedTests: accepted.affectedTests } : {}) };
}

/**
 * The command prefix that runs files submit adds beside its selection. Why: a project with no affectedTests runner
 * still gets the test files its item bar names run, so Node's own test runner takes JavaScript files, as landing
 * diagnosis does; a file it cannot run needs the project's affectedTests, so this names none [C7,V4].
 *
 * @param {string | undefined} configured - The project's affectedTests prefix, if any.
 * @param {string[]} files - Repo-relative test files to run.
 * @returns {string} The prefix, or '' when no runner can run every file.
 */
export function namedFileRunner(configured, files) {
  if (configured?.trim()) return configured;
  return files.length && files.every(file => /\.[cm]?js$/u.test(file)) ? 'node --test' : '';
}

/** Derive exact criterion/final phases once from accepted policy and the selected immutable Git source. */
export function submitGatePlan(root, config, { base, trunk, changed, check, sourceAdvance = false, commit = 'HEAD', crossRunTests = [] }) {
  if (sourceAdvance && commit !== 'HEAD') throw new Refused('BAD_CONFIG', 'source-advance planning requires its actual execution checkout');
  const advancePlan = sourceAdvance ? sourceAdvancePlan(root, config, { base, changed, check }, { selectAffectedTests, selectTestTreeGuards }) : null;
  check = advancePlan ? advancePlan.criterion : check ? mappedCheck(root, check, { commit }) : check;
  const testTiers = sourceAdvance ? null : selectTestTiers(root, { base, trunk, commit, changed, runner: config.affectedTests });
  const selection = testTiers ? { full: false, reason: 'units of unsealed packages and contracts at changed front doors; T3 journeys run per landing batch', files: testTiers.units } : advancePlan?.selection ?? (config.affectedTests
    ? placementSubmitSelection(root, selectAffectedTests(root, { base, trunk, commit, changed }), changed ?? [])
    : { full: true, reason: 'affected-test selection is not enabled for this project', files: [] });
  const deferred = Boolean(testTiers) || !sourceAdvance && config.submitGate === 'landing';
  const deferFullFallback = !testTiers && deferred && selection.full;
  // A selection over submitDeferAbove files moves to the landing gate, which runs every recorded file before the item lands.
  const deferSelection = !testTiers && deferred && !selection.full && Number.isSafeInteger(config.submitDeferAbove) && selection.files.length > config.submitDeferAbove;
  const invariants = testTiers ? [] : advancePlan?.invariants ?? (deferred ? [...new Set(config.submitInvariants ?? [])].sort() : []);
  const registryGuards = testTiers ? [] : advancePlan?.registryGuards ?? [...new Set([...selectRegistryGuards(root, config.registryGuards, { base, trunk, commit, changed, git }),
    ...selectTestTreeGuards(root, { base, trunk, commit, changed })])].sort();
  if ((invariants.length || registryGuards.length) && !config.affectedTests?.trim()) {
    throw new Refused('BAD_CONFIG', 'submitInvariants and repository guards require the project affectedTests runner');
  }
  const testRunner = testTiers?.runner ?? namedFileRunner(config.affectedTests, crossRunTests);
  if (crossRunTests.length && !testRunner?.trim()) throw new Refused('BAD_CONFIG', 'call-adjacent work requires an affected-tests runner for cross-run tests');
  const proofFiles = [...new Set([...(testTiers ? testTierProofFiles(testTiers, check) : [...(deferFullFallback || deferSelection ? [] : selection.files), ...invariants, ...registryGuards]), ...crossRunTests])].sort();
  const guardCommand = registryGuards.length ? `${testRunner.trimEnd()} ${registryGuards.map(path => commandWord('./' + path)).join(' ')}` : '';
  const fullConfig = guardCommand ? { ...config, gate: `(${config.gate}) && ${guardCommand}` } : config;
  const hasFinalProof = !deferFullFallback && !deferSelection && selection.full || proofFiles.length > 0;
  const proofCommand = !deferFullFallback && !deferSelection && selection.full ? fullConfig.gate
    : proofFiles.length ? `${testRunner.trimEnd()} ${proofFiles.map(path => commandWord('./' + path)).join(' ')}` : '';
  const phases = [...(check ? [{ role: 'criterion', command: check }] : []),
    ...(hasFinalProof ? [{ role: 'proof', command: proofCommand }] : [])];
  return { check, selection, deferred, deferFullFallback, deferSelection, invariants, registryGuards,
    proofFiles, fullConfig, hasFinalProof, proofCommand, phases, testTiers, testRunner };
}

/** Decide whether a planned submit needs a browser or GUI slot; a remote analysis runs this beside its plan. */
export async function submitGateAdmission(root, plan, { allowBrowserFreeChecks, onBrowserFallback }) {
  const { check, selection, deferFullFallback, deferSelection, proofFiles } = plan;
  const checkUsesBrowser = check ? (!allowBrowserFreeChecks || await checkNeedsBrowser(root, check, { onFallback: onBrowserFallback })) : false;
  const proofUsesBrowser = deferFullFallback || deferSelection
    ? (proofFiles.length > 0 && (!allowBrowserFreeChecks || await testsNeedBrowser(root, proofFiles, { onFallback: onBrowserFallback })))
    : (selection.full || !allowBrowserFreeChecks || await testsNeedBrowser(root, proofFiles, { onFallback: onBrowserFallback }));
  const gui = (check ? await checkNeedsGui(root, check) : false)
    || ((selection.full && !deferFullFallback && !deferSelection) && projectNeedsGui(root)) || testsNeedGui(root, proofFiles);
  return { browser: checkUsesBrowser || proofUsesBrowser, gui };
}

/** Retain all phase identities; conflicting observations never become an arbitrary file binding [V4,H16]. */
function submitTestOutcomes(profiles) {
  const combined = new Map();
  for (const profile of profiles) {
    if (profile.testOutcomes === undefined) continue;
    const outcomes = testOutcomeFields(profile.testOutcomes);
    if (!outcomes) return null;
    for (const row of outcomes) {
      const key = JSON.stringify([row.file, row.name]);
      const previous = combined.get(key);
      if (previous && (previous.passed !== row.passed || previous.skipped !== row.skipped)) return null;
      combined.set(key, row);
    }
  }
  return testOutcomeFields([...combined.values()]);
}

/**
 * Prove the frozen item check and selected imports under one lease. Subsets neither read nor write
 * the full-gate stamp. An uncertain selection runs the full configured gate and records its reason. A given plan and
 * admission (a runner's, #3006) skip the local planners; `planners` lets a test prove they are never called.
 *
 * @param {string} root
 * @param {any} config
 * @param {{base:string|null, trunk?:string, changed?:string[], check:string, timing?:boolean, agent?:string, item?:string|number, kind?:string, onWait?:(state:object)=>void, onBrowserFallback?:(decision:{file:string,reason:string})=>void}} options
 * @returns {Promise<any>}
 */
export async function runSubmitGate(root, config, { base, trunk, changed, check, timing = false, agent, item = '', kind = 'submit', onWait, onStart, onBrowserFallback, onFailure, proofContext, sourceAdvance = false, outputRoot = root, outputLog, runnerAdmission = {}, executionServices, signatureCapture, staticChecked = false, plan: planned, admission, crossRunTests = [], countTrials = true, onMachineryNote = text => process.stderr.write(text + '\n'),
  planners = { plan: submitGatePlan, admission: submitGateAdmission }, signal }) {

  if (!config.gate.trim()) throw missingGate(root);
  // One pinned main per submit: every phase reads this commit, so a landing mid-submit cannot split the seal (#1777).
  if (trunk !== undefined && trunk !== null && !contains(root, trunk, mainPolicy(root).commit)) {
    throw new Refused('SUBMIT_PIN_NOT_MAIN', `submit pinned main ${trunk.slice(0, 12)}, which is not an ancestor of main; run pullboard submit again so it captures main`);
  }
  if (!staticChecked) await runStaticChecks(root, config, { agent, item, onWait, onBrowserFallback, runnerAdmission, executionServices, artifactDirectory: outputLog ? dirname(outputLog) : undefined });
  // A remote plan is reused only when it covers the required call-adjacent tests.
  const plan = planned ?? planners.plan(root, config, { base, trunk, changed, check, sourceAdvance, crossRunTests });
  const { selection, deferred, deferFullFallback, deferSelection, invariants, registryGuards,
    proofFiles, fullConfig, hasFinalProof } = plan;
  check = plan.check;
  const reusePlan = submitReusePlanDigest({ check, files: proofFiles, full: selection.full, deferred, proofCommand: plan.proofCommand });
  if (plan.testTiers) {
    await runMachineryGuard(outputRoot, () => requireSealedSkips(root, plan.testTiers, { proofFiles, check }),
      { kind: 'selection', rule: requireSealedSkips.toString(), say: onMachineryNote });
    config = { ...config, affectedTests: plan.testRunner };
  } else if (!config.affectedTests?.trim() && plan.testRunner?.trim()) {
    // No configured runner: the bar-named files run with the plan's own runner [C7,V4].
    config = { ...config, affectedTests: plan.testRunner };
  }
  for (const path of [...invariants, ...registryGuards]) {
    let file = false;
    try { file = statSync(join(root, path)).isFile(); } catch { /* Missing or unreadable invariants refuse rather than silently disappearing. */ }
    if (!file) throw new Refused('BAD_CONFIG', `${invariants.includes(path) ? 'submitInvariants' : 'registryGuards'} file ${path} is missing or unreadable; restore it or update the list on accepted main`);
  }
  const { browser, gui } = admission ?? await planners.admission(root, plan, { allowBrowserFreeChecks: browserFreeChecksEnabled(), onBrowserFallback });
  const slotOptions = { executionServices, browser, gui, agent, item, kind, itemCheck: true, timing, onWait, signal, ...runnerAdmission };
  /** Red phases whose flake diagnostics wait until the gate's result is made and its slot is free. */
  const diagnostics = [];
  const gateResult = await withGateSlot(root, async (lease) => {
    lease.timingOperation = 'submit';
    // Observe the real grant before proof; both callbacks share the admission object and preserve its first witness.
    await onStart?.();
    // Immediate admission may have no queue poll; retain the existing quarantine callback when no witness exists yet.
    if (proofContext?.admission && !proofContext.admission.id) await onWait?.({ admitted: true });
    if (signatureCapture) lease.signatureCapture = signatureCapture;
    lease.testTiers = Boolean(plan.testTiers);
    lease.quarantines = proofContext?.quarantines ?? [];
    if (proofContext) lease.proof = { ...proofContext, kind: 'submit',
      ...(proofContext.companion ? { submitPhase: 'criterion' } : {}),
      ...(!hasFinalProof && proofContext.admission?.id ? { submitAdmission: proofContext.admission.id } : {}),
      ...(proofContext.admission?.id ? { diagnosticAdmission: proofContext.admission.id } : {}) };
    pinRunMain(lease, onFailure);
    lease.pinnedMain = trunk ?? null;
    const startedAt = Date.now();
    const log = outputLog ?? gitPath(outputRoot, 'pullboard-submit.log');
    const checkLog = `${log}.check.log`;
    const proofLog = `${log}.proof.log`;
    /** Isolate each concurrently executing phase's source context, tracker and receipt list. */
    const phaseLease = role => ({ ...lease, executionServices: lease.executionServices, tracker: startReceipt(),
      proofReceiptIds: [], ...(lease.proof ? { proof: { ...lease.proof,
        ...(proofContext?.admission?.id ? { submitPhase: role, submitAdmission: proofContext.admission.id, submitReuse: true, submitReusePlan: reusePlan } : {}) } } : {}) });
    const criterionLease = phaseLease('criterion');
    const proofLease = phaseLease('proof');
    const proofWait = check ? 0 : lease.waitMs;
    /** Launch final proof under its own phase context while preserving its full-gate stamping rules. */
    const prove = async () => {
      if (!deferFullFallback && selection.full) return fullGateRunAsync(root, fullConfig, false, { waitMs: proofWait, log: proofLog, gateLease: proofLease, stages: true, kind: 'submit', signal });
      if (!proofFiles.length) return { isGreen: true, output: '', seconds: 0, isCached: false, log: '' };
      const filesCommand = files => `${config.affectedTests.trimEnd()} ${files.map(path => commandWord('./' + path)).join(' ')}`;
      const command = filesCommand(proofFiles);
      const options = { waitMs: proofWait, profileFile: `${proofLog}.profile.json`, gateLease: proofLease, stages: true, signal };
      // The files run from a queue of batches every slot the gate gets pulls from; the one receipt still names the whole command [C7].
      const run = { ...await (proofFiles.length > 1
        ? runProfiledShardsAsync(root, command, options, execution => proveShards(execution, filesCommand))
        : runProfiledShellAsync(root, command, options)), isCached: false, log: proofLog };
      writeFileSync(proofLog, run.output);
      if (plan.testTiers) requireTestTierAccount(run, proofFiles);
      return run;
    };
    /**
     * Run the proof's files from a queue of small batches and merge them into one run. The gate's own lease is the first
     * lane; on a runner the gate keeps asking for more runner slots while batches remain, and each slot pulls batches
     * until the queue is empty. Slot lanes carry no proof context, so the gate's lease writes the only receipt. Every
     * batch reports its test account under the proof's one timing run id, so the merged output accounts for every
     * selected file (TEST_SELECTION_UNVERIFIED). With no runner lease the one local lane runs every batch as today's
     * command. A rerun of the same candidate tree after an infrastructure end runs only the batches with no recorded
     * pass (#3699).
     */
    const proveShards = async (execution, filesCommand) => {
      const runners = execution.gateLease.executionServices.runners;
      const shardOptions = shardLease => ({ ...execution.remoteOptions, runner: shardLease.runner, source: shardLease.source,
        runnerWaitDeadline: shardLease.runnerWaitDeadline, browser: shardLease.browser, byLaunch: shardLease.browserByLaunch,
        metadata: { ...execution.remoteOptions.metadata, ...(shardLease.runMetadata ?? {}), timingRunId: execution.remoteOptions.metadata.timingRunId } });
      /** Take one more runner slot and let `lane` pull batches on it; the request ends once the queue has closed. */
      const takeSlot = (lane, { closed }) => withGateSlot(root, shardLease => lane(files => runners.runOnRunnerAsync(root, filesCommand(files), shardOptions(shardLease))),
        shardSlotOptions(slotOptions, { closed }));
      // A browser proof opens only as many requests as runners have browser slots free, so none waits on its siblings [C7].
      const freeSlots = !lease.runner ? 0 : planners.freeSlots ? planners.freeSlots() : freeRunnerSlots(undefined, { browser, gui, runners: runners.effectiveRunners(loadMachineSettings()) });
      return proveBatches(root, execution, { files: proofFiles, filesCommand, takeSlot, freeSlots, times: readFileTimes(root), say: onMachineryNote });
    };
    lease.tracker?.mark('runAt');
    /** Retain completed check evidence even when the later proof refuses its runner. */
    const criterionRun = async () => {
      const run = check
        ? await runProfiledShellAsync(root, check, { waitMs: lease.waitMs, profileFile: `${checkLog}.profile.json`, gateLease: criterionLease, stages: true, signal })
        : { isGreen: true, output: '', seconds: 0 };
      if (check) writeFileSync(checkLog, safeLog(run.output), { mode: 0o600 });
      return run;
    };
    // One remote lease holds one controller at a time. Local phases can still overlap; either way,
    // drain both phases even on rejection so their receipts and the admission lease stay accurate.
    const outcomes = lease.runner
      ? [...await Promise.allSettled([criterionRun()]), ...await Promise.allSettled([prove()])]
      : await Promise.allSettled([criterionRun(), prove()]);
    lease.tracker?.mark('ranAt');
    lease.proofReceiptIds = [...(lease.proofReceiptIds ?? []), ...criterionLease.proofReceiptIds, ...proofLease.proofReceiptIds];
    const active = [criterionLease, proofLease].filter(value => value.environment);
    lease.environment = active.length && active.every(value => JSON.stringify(value.environment) === JSON.stringify(active[0].environment)) ? active[0].environment : null;
    // Two overlapping remote intervals have no single authenticated aggregate admission or phase record.
    lease.executionAdmission = active.length === 1 ? active[0].executionAdmission : null;
    lease.executionPhases = active.length === 1 ? active[0].executionPhases : null;
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure) throw failure.reason;
    const [criterion, proof] = outcomes.map(outcome => outcome.value);
    await recordRun(onFailure, criterion);
    const receipt = { command: check, green: criterion.isGreen, seconds: criterion.seconds, checked: Boolean(check),
      ...(criterion.blockingVerdict ? { rawExitCode: criterion.exitCode, blockingVerdict: criterion.blockingVerdict } : {}),
      ...(check ? { log: checkLog, profilePath: criterion.profilePath, profile: criterion.profile } : {}) };
    /** Persist the whole submission's wall time and queue wait once, alongside its combined raw log. */
    const finish = (proof) => {
      const profilePath = `${log}.profile.json`;
      const profiles = [criterion.profile, proof.profile].filter(Boolean);
      const profile = writeTimingProfile(profilePath, {
        waitMs: lease.waitMs, wallMs: Math.max(0, Date.now() - startedAt),
        files: profiles.flatMap(value => value.files), tests: profiles.flatMap(value => value.tests),
        testOutcomes: submitTestOutcomes(profiles),
        runner: [...new Set(profiles.map(value => value.runner))].join(', '),
        format: [...new Set(profiles.map(value => value.format))].join('+'),
        unavailable: profiles.some(value => value.unavailable) ? 'per-test timing unavailable: output was not TAP or JUnit (one or more phases)' : null,
        ...(lease.runner ? { executionRunner: lease.runner.host,
          executionSource: profiles.find(value => value.executionSource)?.executionSource } : {}),
      });
      refuseSandboxBlocked(proof);
      return { ...proof, ...(criterion.timedOut || proof.timedOut ? { timedOut: true } : {}), executionRoot: proof.executionRoot ?? root, ...(criterion.cleanupUnverified || proof.cleanupUnverified ? { cleanupUnverified: true } : {}), log, seconds: Math.round((Date.now() - startedAt) / 1000), ...selection, files: proofFiles, registryGuards, ...(plan.testTiers ? { testTiers: plan.testTiers } : {}), ...(deferred ? { submitInvariants: invariants } : {}),
        ...(deferSelection ? { deferredFiles: selection.files, deferAbove: config.submitDeferAbove } : {}), deferred, deferFullFallback, check: receipt,
        profile, profilePath, proofProfilePath: proof.profilePath, proofLog: proof.log,
        ...(criterion.blockingVerdict || proof.blockingVerdict ? { phaseVerdicts: [criterion, proof].flatMap((phase, index) => phase.blockingVerdict ? [{
          role: index === 0 ? 'criterion' : 'proof', rawExitCode: phase.exitCode, blockingVerdict: phase.blockingVerdict }] : []) } : {}),
        phasePlan: plan.phases,
        proofReceiptIds: [...(check ? [criterion.proofReceiptId ?? null] : []),
          ...(proof.profile ? [proof.proofReceiptId ?? null] : [])] };
    };
    if (!criterion.isGreen && onFailure) diagnostics.push([{ ...criterion, log: checkLog }, { root, command: check, lease: criterionLease }]);
    const phase = plan.testTiers ? testTierReport(plan.testTiers) : deferFullFallback || deferSelection
      ? `submit invariants: ${invariants.length ? invariants.join(', ') : 'none'}; ${deferSelection ? `${selection.files.length} affected test files` : 'full suite'} deferred to the landing gate`
      : selection.full ? 'full gate' : 'affected tests';
    writeFileSync(log, `item check:\n${criterion.output}\n${phase}:\n${proof.output}`);
    if (!proof.isGreen && onFailure) diagnostics.push([proof, { root,
      command: !deferFullFallback && selection.full ? fullConfig.gate : `${config.affectedTests.trimEnd()} ${proofFiles.map(path => commandWord('./' + path)).join(' ')}`, lease: proofLease }]);
    await recordRun(onFailure, proof);
    refuseSandboxBlocked(criterion);
    const result = finish(proof);
    let trials = [];
    const observed = result.proofReceiptIds.filter(id => typeof id === 'string');
    if (countTrials && criterion.isGreen && result.isGreen && observed.length) {
      try { trials = countTrialGate(outputRoot, { id: JSON.stringify(observed.sort()) }); } catch { /* A ledger failure cannot alter the recorded test proof. */ }
    }
    if (trials.length) writeFileSync(log, `item check:\n${criterion.output}\n${phase}:\n${proof.output}\n${trials.join('\n')}\n`);
    result.refusalTrials = trials;
    return criterion.isGreen ? result : { ...result, isGreen: false, completedProof: proof,
      criterionRed: { isGreen: false, output: criterion.output, stages: criterion.stages,
        ...(criterion.blockingVerdict ? { blockingVerdict: criterion.blockingVerdict, exitCode: criterion.exitCode, rawIsGreen: false, quarantineFailures: criterion.quarantineFailures } : {}),
        executionRoot: criterion.executionRoot ?? root, executionRunner: criterion.executionRunner, environment: criterion.environment, profile: criterion.profile } };
  }, slotOptions);
  if (diagnostics.length) await diagnoseAfterResult(root, onFailure, diagnostics, slotOptions);
  return gateResult;
}

/**
 * Run a red gate's flake diagnostics after its result is made and its gate slot is released, in a slot of their own.
 * Each diagnostic keeps the proof context of the phase it observes, so its probes stay bound to the admitted submit.
 *
 * Why: diagnostics used to run inside the gate's runner lease, holding the worker for minutes after the result was
 * known (#3324); they never change that result, so a failure here is reported and the gate's result stands.
 *
 * @param {string} root
 * @param {(run: object, context: { root: string, command: string, lease: object }) => Promise<void>} onFailure
 * @param {[object, { root: string, command: string, lease: object }][]} diagnostics - Each red run and its phase context.
 * @param {object} slotOptions - The gate's own slot options.
 * @returns {Promise<void>}
 */
async function diagnoseAfterResult(root, onFailure, diagnostics, slotOptions) {
  try {
    await withGateSlot(root, async (lease) => {
      for (const [run, context] of diagnostics) {
        const phase = context.lease;
        Object.assign(lease, { timingOperation: 'submit', proof: phase.proof, runMetadata: phase.runMetadata, quarantines: phase.quarantines ?? [],
          pinnedMain: phase.pinnedMain ?? null, testTiers: phase.testTiers, tracker: startReceipt(), proofReceiptIds: [] });
        await onFailure(run, { ...context, lease });
      }
    }, slotOptions);
  } catch (error) {
    process.stderr.write(`flake diagnostics could not run after the gate (${error?.code ?? 'FLAKE_DIAGNOSTIC_FAILED'}); the gate's result stands\n`);
  }
}

