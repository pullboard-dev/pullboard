import { submitReusePlanDigest } from '../../../verify/index.js';
import { requireTestTierAccount } from './test-tier-selection.js';
import { selectTestTiers } from './test-tier-selection.js';
import { testTierProofFiles } from './test-tier-selection.js';
import { testTierReport } from './test-tier-selection.js';
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
  runProfiledShellAsync,
  safeLog,
} from './gate-execution.js';
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

/** Derive exact criterion/final phases once from accepted policy and the selected immutable Git source. */
export function submitGatePlan(root, config, { base, trunk, changed, check, sourceAdvance = false, commit = 'HEAD' }) {
  if (sourceAdvance && commit !== 'HEAD') throw new Refused('BAD_CONFIG', 'source-advance planning requires its actual execution checkout');
  const advancePlan = sourceAdvance ? sourceAdvancePlan(root, config, { base, changed, check }, { selectAffectedTests, selectTestTreeGuards }) : null;
  check = advancePlan ? advancePlan.criterion : check ? mappedCheck(root, check, { commit }) : check;
  const testTiers = sourceAdvance ? null : selectTestTiers(root, { base, trunk, commit, changed, runner: config.affectedTests });
  const selection = testTiers ? { full: false, reason: 'T1 units of changed packages; T3 journeys run per landing batch', files: testTiers.units } : advancePlan?.selection ?? (config.affectedTests
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
  const testRunner = testTiers?.runner ?? config.affectedTests;
  const proofFiles = testTiers ? testTierProofFiles(testTiers, check) : [...new Set([...(deferFullFallback || deferSelection ? [] : selection.files), ...invariants, ...registryGuards])].sort();
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
 * the full-gate stamp. An uncertain selection runs the full configured gate and records its reason.
 *
 * @param {string} root
 * @param {any} config
 * @param {{base:string|null, trunk?:string, changed?:string[], check:string, timing?:boolean, agent?:string, item?:string|number, kind?:string, onWait?:(state:object)=>void, onBrowserFallback?:(decision:{file:string,reason:string})=>void}} options
 * @returns {Promise<any>}
 */
export async function runSubmitGate(root, config, { base, trunk, changed, check, timing = false, agent, item = '', kind = 'submit', onWait, onStart, onBrowserFallback, onFailure, proofContext, sourceAdvance = false, outputRoot = root, outputLog, runnerAdmission = {}, executionServices, signatureCapture, staticChecked = false }) {

  if (!config.gate.trim()) throw missingGate(root);
  // One pinned main per submit: every phase reads this commit, so a landing mid-submit cannot split the seal (#1777).
  if (trunk !== undefined && trunk !== null && !contains(root, trunk, mainPolicy(root).commit)) {
    throw new Refused('SUBMIT_PIN_NOT_MAIN', `submit pinned main ${trunk.slice(0, 12)}, which is not an ancestor of main; run pullboard submit again so it captures main`);
  }
  if (!staticChecked) await runStaticChecks(root, config, { agent, item, onWait, onBrowserFallback, runnerAdmission, executionServices, artifactDirectory: outputLog ? dirname(outputLog) : undefined });
  const plan = submitGatePlan(root, config, { base, trunk, changed, check, sourceAdvance });
  const { selection, deferred, deferFullFallback, deferSelection, invariants, registryGuards,
    proofFiles, fullConfig, hasFinalProof } = plan;
  check = plan.check;
  const reusePlan = submitReusePlanDigest({ check, files: proofFiles, full: selection.full, deferred, proofCommand: plan.proofCommand });
  if (plan.testTiers) config = { ...config, affectedTests: plan.testRunner };
  for (const path of [...invariants, ...registryGuards]) {
    let file = false;
    try { file = statSync(join(root, path)).isFile(); } catch { /* Missing or unreadable invariants refuse rather than silently disappearing. */ }
    if (!file) throw new Refused('BAD_CONFIG', `${invariants.includes(path) ? 'submitInvariants' : 'registryGuards'} file ${path} is missing or unreadable; restore it or update the list on accepted main`);
  }
  const allowBrowserFreeChecks = browserFreeChecksEnabled();
  const checkUsesBrowser = check ? (!allowBrowserFreeChecks || await checkNeedsBrowser(root, check, { onFallback: onBrowserFallback })) : false;
  const proofUsesBrowser = deferFullFallback || deferSelection
    ? (proofFiles.length > 0 && (!allowBrowserFreeChecks || await testsNeedBrowser(root, proofFiles, { onFallback: onBrowserFallback })))
    : (selection.full || !allowBrowserFreeChecks || await testsNeedBrowser(root, proofFiles, { onFallback: onBrowserFallback }));
  const browser = checkUsesBrowser || proofUsesBrowser;
  const gui = (check ? await checkNeedsGui(root, check) : false)
    || ((selection.full && !deferFullFallback && !deferSelection) && projectNeedsGui(root)) || testsNeedGui(root, proofFiles);
  return await withGateSlot(root, async (lease) => {
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
      if (!deferFullFallback && selection.full) return fullGateRunAsync(root, fullConfig, false, { waitMs: proofWait, log: proofLog, gateLease: proofLease, stages: true, kind: 'submit' });
      if (!proofFiles.length) return { isGreen: true, output: '', seconds: 0, isCached: false, log: '' };
      const command = `${config.affectedTests.trimEnd()} ${proofFiles.map(path => commandWord('./' + path)).join(' ')}`;
      const run = { ...await runProfiledShellAsync(root, command, { waitMs: proofWait, profileFile: `${proofLog}.profile.json`, gateLease: proofLease, stages: true }), isCached: false, log: proofLog };
      writeFileSync(proofLog, run.output);
      if (plan.testTiers) requireTestTierAccount(run, proofFiles);
      return run;
    };
    lease.tracker?.mark('runAt');
    /** Run the criterion with its own source context and receipt. */
    const criterionRun = () => check
      ? runProfiledShellAsync(root, check, { waitMs: lease.waitMs, profileFile: `${checkLog}.profile.json`, gateLease: criterionLease, stages: true })
      : Promise.resolve({ isGreen: true, output: '', seconds: 0 });
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
    if (check) writeFileSync(checkLog, safeLog(criterion.output), { mode: 0o600 });
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
      return { ...proof, executionRoot: proof.executionRoot ?? root, ...(criterion.cleanupUnverified || proof.cleanupUnverified ? { cleanupUnverified: true } : {}), log, seconds: Math.round((Date.now() - startedAt) / 1000), ...selection, files: proofFiles, registryGuards, ...(plan.testTiers ? { testTiers: plan.testTiers } : {}), ...(deferred ? { submitInvariants: invariants } : {}),
        ...(deferSelection ? { deferredFiles: selection.files, deferAbove: config.submitDeferAbove } : {}), deferred, deferFullFallback, check: receipt,
        profile, profilePath, proofProfilePath: proof.profilePath, proofLog: proof.log,
        ...(criterion.blockingVerdict || proof.blockingVerdict ? { phaseVerdicts: [criterion, proof].flatMap((phase, index) => phase.blockingVerdict ? [{
          role: index === 0 ? 'criterion' : 'proof', rawExitCode: phase.exitCode, blockingVerdict: phase.blockingVerdict }] : []) } : {}),
        phasePlan: plan.phases,
        proofReceiptIds: [...(check ? [criterion.proofReceiptId ?? null] : []),
          ...(proof.profile ? [proof.proofReceiptId ?? null] : [])] };
    };
    if (!criterion.isGreen && onFailure) await onFailure({ ...criterion, log: checkLog }, { root, command: check, lease: criterionLease });
    const phase = plan.testTiers ? testTierReport(plan.testTiers) : deferFullFallback || deferSelection
      ? `submit invariants: ${invariants.length ? invariants.join(', ') : 'none'}; ${deferSelection ? `${selection.files.length} affected test files` : 'full suite'} deferred to the landing gate`
      : selection.full ? 'full gate' : 'affected tests';
    writeFileSync(log, `item check:\n${criterion.output}\n${phase}:\n${proof.output}`);
    if (!proof.isGreen && onFailure) await onFailure(proof, { root,
      command: !deferFullFallback && selection.full ? fullConfig.gate : `${config.affectedTests.trimEnd()} ${proofFiles.map(path => commandWord('./' + path)).join(' ')}`, lease: proofLease });
    await recordRun(onFailure, proof);
    refuseSandboxBlocked(criterion);
    const result = finish(proof);
    return criterion.isGreen ? result : { ...result, isGreen: false, completedProof: proof,
      criterionRed: { isGreen: false, output: criterion.output, stages: criterion.stages,
        ...(criterion.blockingVerdict ? { blockingVerdict: criterion.blockingVerdict, exitCode: criterion.exitCode, rawIsGreen: false, quarantineFailures: criterion.quarantineFailures } : {}),
        executionRoot: criterion.executionRoot ?? root, executionRunner: criterion.executionRunner, environment: criterion.environment, profile: criterion.profile } };
  }, { executionServices, browser, gui, agent, item, kind, itemCheck: true, timing, onWait, ...runnerAdmission });
}

