/** Concern-specific gate stage; public callers keep the gate facade. */
import { sourceAdvancePlan } from './source-advance-plan.js';
import {
  withGateSlot,
} from './gate-slot.js';
import {
  mappedCheck,
} from './path-map.js';
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
} from './git.js';
import {
  Refused,
} from './refused.js';
import {
  missingGate,
} from './gate-config.js';
import { contains } from './git.js';
import { mainPolicy } from './trusted-policy-read.js';
import {
  browserFreeChecksEnabled,
} from './settings.js';
import {
  selectAffectedTests,
  selectTestTreeGuards,
} from './affected-tests.js';
import {
  selectRegistryGuards,
} from './registry-guards.js';
import {
  checkNeedsBrowser,
  testsNeedBrowser,
} from './browser-admission.js';
import {
  writeTimingProfile,
} from './gate-output.js';
import {
  fullGateRun,
  pinRunMain,
  recordRun,
  refuseSandboxBlocked,
  runProfiledShell,
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
  const advancePlan = sourceAdvance ? sourceAdvancePlan(root, config, { base, changed, check }) : null;
  check = advancePlan ? advancePlan.criterion : check ? mappedCheck(root, check, { commit }) : check;
  const selection = advancePlan?.selection ?? (config.affectedTests
    ? placementSubmitSelection(root, selectAffectedTests(root, { base, trunk, commit, changed }), changed ?? [])
    : { full: true, reason: 'affected-test selection is not enabled for this project', files: [] });
  const deferred = !sourceAdvance && config.submitGate === 'landing';
  const deferFullFallback = deferred && selection.full;
  // A selection over submitDeferAbove files moves to the landing gate, which runs every recorded file before the item lands.
  const deferSelection = deferred && !selection.full && Number.isSafeInteger(config.submitDeferAbove) && selection.files.length > config.submitDeferAbove;
  const invariants = advancePlan?.invariants ?? (deferred ? [...new Set(config.submitInvariants ?? [])].sort() : []);
  const registryGuards = advancePlan?.registryGuards ?? [...new Set([...selectRegistryGuards(root, config.registryGuards, { base, trunk, commit, changed, git }),
    ...selectTestTreeGuards(root, { base, trunk, commit, changed })])].sort();
  if ((invariants.length || registryGuards.length) && !config.affectedTests?.trim()) {
    throw new Refused('BAD_CONFIG', 'submitInvariants and repository guards require the project affectedTests runner');
  }
  const proofFiles = [...new Set([...(deferFullFallback || deferSelection ? [] : selection.files), ...invariants, ...registryGuards])].sort();
  const guardCommand = registryGuards.length ? `${config.affectedTests.trimEnd()} ${registryGuards.map(path => commandWord('./' + path)).join(' ')}` : '';
  const fullConfig = guardCommand ? { ...config, gate: `(${config.gate}) && ${guardCommand}` } : config;
  const hasFinalProof = !deferFullFallback && !deferSelection && selection.full || proofFiles.length > 0;
  const proofCommand = !deferFullFallback && !deferSelection && selection.full ? fullConfig.gate
    : proofFiles.length ? `${config.affectedTests.trimEnd()} ${proofFiles.map(path => commandWord('./' + path)).join(' ')}` : '';
  const phases = [...(check ? [{ role: 'criterion', command: check }] : []),
    ...(hasFinalProof ? [{ role: 'proof', command: proofCommand }] : [])];
  return { check, selection, deferred, deferFullFallback, deferSelection, invariants, registryGuards,
    proofFiles, fullConfig, hasFinalProof, proofCommand, phases };
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
export async function runSubmitGate(root, config, { base, trunk, changed, check, agent, item = '', kind = 'submit', onWait, onBrowserFallback, onFailure, proofContext, sourceAdvance = false, outputRoot = root }) {
  if (!config.gate.trim()) throw missingGate(root);
  // One pinned main per submit: every phase reads this commit, so a landing mid-submit cannot split the seal (#1777).
  if (trunk !== undefined && trunk !== null && !contains(root, trunk, mainPolicy(root).commit)) {
    throw new Refused('SUBMIT_PIN_NOT_MAIN', `submit pinned main ${trunk.slice(0, 12)}, which is not an ancestor of main; run pullboard submit again so it captures main`);
  }
  await runStaticChecks(root, config, { agent, item, onWait, onBrowserFallback });
  const plan = submitGatePlan(root, config, { base, trunk, changed, check, sourceAdvance });
  const { selection, deferred, deferFullFallback, deferSelection, invariants, registryGuards,
    proofFiles, fullConfig, hasFinalProof } = plan;
  check = plan.check;
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
    if (proofContext) lease.proof = { ...proofContext, kind: 'submit',
      ...(proofContext.companion ? { submitPhase: 'criterion' } : {}),
      ...(!hasFinalProof && proofContext.admission?.id ? { submitAdmission: proofContext.admission.id } : {}) };
    pinRunMain(lease, onFailure);
    lease.pinnedMain = trunk ?? null;
    const startedAt = Date.now();
    const log = gitPath(outputRoot, 'pullboard-submit.log');
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
      return { ...proof, ...(criterion.cleanupUnverified || proof.cleanupUnverified ? { cleanupUnverified: true } : {}), log, seconds: criterion.seconds + proof.seconds, ...selection, files: proofFiles, registryGuards, ...(deferred ? { submitInvariants: invariants } : {}),
        ...(deferSelection ? { deferredFiles: selection.files, deferAbove: config.submitDeferAbove } : {}), deferred, deferFullFallback, check: receipt,
        profile, profilePath, proofProfilePath: proof.profilePath, proofLog: proof.log,
        phasePlan: plan.phases,
        proofReceiptIds: [...(check ? [criterion.proofReceiptId ?? null] : []),
          ...(proof.profile ? [proof.proofReceiptId ?? null] : [])] };
    };
    if (!criterion.isGreen) {
      writeFileSync(log, criterion.output);
      if (onFailure) await onFailure({ ...criterion, log: checkLog }, { root, command: check, lease });
      return finish({ isGreen: false, sandboxBlocked: criterion.sandboxBlocked, isCached: false, output: criterion.output, seconds: 0, log: '' });
    }
    // The proof already owns this lease: its phase profile has no additional queue wait.
    if (hasFinalProof && proofContext?.admission?.id) lease.proof.submitAdmission = proofContext.admission.id;
    const proofWait = check ? 0 : lease.waitMs;
    if (proofContext?.companion) lease.proof.submitPhase = 'proof';
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

