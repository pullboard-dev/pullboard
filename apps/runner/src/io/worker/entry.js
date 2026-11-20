import { environmentAdapter } from '../../../../../packages/env/index.js';
import { auditAdapterEnvironment } from '../../../../../packages/kernel/light.js';
import { processCensus } from '../custody.js';
import { scheduledChromeCloneSweep } from '../chrome.js';
/** Execute one remote job end to end; stdout is reserved for raw command bytes and stderr for one receipt [C7]. */
import { checkoutHistory } from './checkout.js';
import { installDependencies } from './checkout.js';
import { beginCleanup } from './cleanup.js';
import { assertDiskFree } from '../sweep.js';
import { diskFloorBytes } from '../sweep.js';
import { sweepRunnerDiskForWorker } from '../sweep.js';
import { writeTerminalResult } from '../sweep.js';
import { releaseDrainedLease } from './cleanup.js';
import { reportCleanupTimeout } from './cleanup.js';
import { outputSink } from './command.js';
import { runCommand } from './command.js';
import { runPrivateCheck } from './command.js';
import { runHandoffJob } from './handoff.js';
import { acquireResourceApi } from './environment.js';
import { loadResourceApi } from './environment.js';
import { registeredCapacity } from './environment.js';
import { scopedEnvironment } from './environment.js';
import { assertTransportLive } from './process.js';
import { retrySlotLocked } from './process.js';
import { drainAllOwned } from './process.js';
import { installSignalCustody } from './process.js';
import { watchJobFolder } from './orphan.js';
import { receipt } from './receipt.js';
import { collectScreenshots } from './screenshots.js';
import { safeSetupMessage } from './receipt.js';
import { setupRefusalCode } from './receipt.js';
import { stopReading } from './receipt.js';
import { readSpec } from './spec.js';
import { BROWSER_REFUSAL_FILE } from '../../../../../packages/resources/light.js';
import { receiveAnalysisArtifact } from '../../../../../packages/resources/light.js';
import { machineSettingsFile } from '../../../../../packages/resources/light.js';
import { captureTestRuntimes } from '../../../../../packages/sandbox/light.js';
import { guiSession } from '../../../../../packages/gate/light.js';
import { Refused } from '../../../../../packages/kernel/light.js';
import { createDescendantTracker } from '../custody.js';
import { sampleRunnerLoad } from '../../../../../packages/runners/light.js';
import { SCREENSHOT_DIRECTORY } from '../../../../../packages/runners/light.js';
import { SCREENSHOT_MAX_BYTES } from '../../../../../packages/runners/light.js';
import { screenshotPlan } from '../../../../../packages/runners/light.js';
import { pinSourceCacheJob } from '../../../../../packages/runners/light.js';
import { recordRunnerCompletion } from '../../../../../packages/runners/light.js';
import { recordRunnerOwner } from '../../../../../packages/runners/light.js';
import { TEST_RESULT_REQUEST_ENV } from '../../../../../packages/gate/light.js';
import { TEST_RESULT_ORIGIN_ENV } from '../../../../../packages/gate/light.js';
import { TEST_RESULT_STORE_ENV } from '../../../../../packages/gate/light.js';
import { importTestResults } from '../../../../../packages/gate/light.js';
import { packTestResults } from '../../../../../packages/gate/light.js';
import { selectedTestResults } from '../../../../../packages/gate/light.js';
import { startRunnerPhases } from '../../../../../packages/gate/light.js';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/** Whether this runner machine's own gate.sampleDiskIo is on; an unreadable settings file reads off [C7,#9029]. */
function diskIoSetting() {
  try { return JSON.parse(fs.readFile(machineSettingsFile(), 'utf8')).gate?.sampleDiskIo === true; } catch { return false; }
}

/** Execute one remote job end to end; stdout is reserved for raw command bytes and stderr for one receipt. */
export async function main(S) {
  installSignalCustody(S);
  const spec = await readSpec(S);
  S.workSpecAccepted = true;
  S.workerId = spec.id;
  const orphanWatch = watchJobFolder(S);
  const sink = outputSink(S);
  const phases = startRunnerPhases();
  let api;
  let lease = null;
  let tracker = null;
  let runtimeCapture = null;
  let sourceMetrics = null;
  let runDirectory;
  let recoveryRoot;
  let setupStep = 'runner directories';
  let gui = null;
  let dependencies = 'none';
  let final = { code: 1, signal: null, root: '' };
  /** Send the one result receipt before any slow cleanup; a lost transport has no one to tell. */
  async function reportResult() {
    if (S.transportLost) return;
    try {
      if (lease?.executionAdmission) {
        const endLoad = sampleRunnerLoad({ diskIo: diskIoSetting() });
        final.executionAdmission = { ...lease.executionAdmission, ...lease.timingEvidence(), finishedAt: endLoad.at, load: { ...lease.executionAdmission.load, end: endLoad } };
      }
      final.testRuntimes = runtimeCapture?.finish() ?? null;
      final.executionPhases = phases.finish();
      final.sourcePreparation = sourceMetrics;
      // A failed listing sends the result without screenshots; the job's own outcome is never lost to them.
      let shots = { screenshots: [] };
      try { shots = collectScreenshots(final.root, { screenshotPlan, maxBytes: SCREENSHOT_MAX_BYTES, directory: SCREENSHOT_DIRECTORY }); } catch { /* The result still goes out without screenshots. */ }
      S.cleanupStage = 'result receipt';
      await receipt(spec, { ...final, ...(shots.refused && !final.refused ? { refused: shots.refused.code } : {}), screenshots: shots.screenshots, gui, dependencies }, sink);
      S.resultSent = true;
      // The delivered result is the job's terminal record: the disk sweep may remove this folder even if the worker dies.
      try { if (runDirectory) writeTerminalResult(runDirectory); } catch { /* The quiet window still protects the folder. */ }
    } catch (error) {
      try { process.stderr.write(`PULLBOARD_RUNNER_RESULT_UNSENT ${S.workerId} ${String(error?.code ?? error?.name).slice(0, 64)}\n`); } catch { /* A dead transport has no one to tell. */ }
      S.transportDrop();
    }
  }
  try {
    const runnerHome = isAbsolute(environmentAdapter().get('HOME') || '') ? environmentAdapter().get('HOME') : userInfo().homedir;
    const runnerRoot = spec.root ?? join(runnerHome, '.pullboard-runner');
    recoveryRoot = runnerRoot;
    S.setupPrivatePaths.add(runnerRoot);
    fs.mkdir(runnerRoot, { recursive: true, mode: 0o700 });
    S.setupPrivatePaths.add(fs.realpath(runnerRoot));
    fs.chmod(runnerRoot, 0o700);
    const configuredMachineHome = environmentAdapter().get('PULLBOARD_MACHINE_HOME');
    if (configuredMachineHome !== undefined && !isAbsolute(configuredMachineHome)) throw new Error('machine home is invalid');
    const machineHomePath = configuredMachineHome ?? join(runnerHome, '.pullboard');
    S.setupPrivatePaths.add(machineHomePath);
    setupStep = 'trusted resource API';
    api = loadResourceApi(spec.runtime);
    // The registration travels with the job; this machine's own settings never size a runner (#1066).
    const { gateCapacity, browserCapacity } = registeredCapacity(api, spec, runnerRoot, machineHomePath);
    setupStep = 'job directories';
    const base = join(runnerRoot, 'jobs');
    fs.mkdir(base, { recursive: true, mode: 0o700 });
    fs.chmod(base, 0o700);
    setupStep = 'disk sweep';
    assertDiskFree(await sweepRunnerDiskForWorker(runnerRoot, spec.id, Date.now() + 60_000, api, machineHomePath), diskFloorBytes(machineHomePath));
    setupStep = 'job directories';
    runDirectory = fs.mkdtemp(join(base, `${spec.id}-`));
    S.cleanupDirectory = runDirectory;
    recordRunnerOwner(runDirectory, processCensus);
    setupStep = 'analysis artifact';
    const analysisArtifactPath = spec.analysisArtifact ? await receiveAnalysisArtifact(S, runDirectory, spec.analysisArtifact) : null;
    const root = join(runDirectory, 'checkout');
    const privateHome = join(runDirectory, 'home');
    const temporary = join(runDirectory, 'tmp');
    fs.mkdir(root, { mode: 0o700 }); fs.mkdir(privateHome, { mode: 0o700 }); fs.mkdir(temporary, { mode: 0o700 });
    fs.close(fs.open(join(privateHome, 'npm-userconfig'), 'w', 0o600));
    fs.close(fs.open(join(privateHome, 'npm-globalconfig'), 'w', 0o600));
    const pinLease = await retrySlotLocked(S, () => acquireResourceApi(api, {
      name: `repo-${spec.repoId}`, capacity: 1, scope: 'machine', root: runnerRoot,
      repo: runnerRoot, agent: `pullboard-ssh-pin-${spec.id}`, kind: 'source-cache',
      onWait: () => assertTransportLive(S),
    }, join(runnerRoot, 'cache', 'resource-pool')));
    try { pinSourceCacheJob(runDirectory, spec); } finally { pinLease.release(); }
    const packFile = join(runDirectory, 'source.pack');
    setupStep = 'runner gate admission';
    phases.mark('capacityWaitMs');
    lease = await retrySlotLocked(S, () => acquireResourceApi(api, {
      name: 'gate', capacity: gateCapacity, scope: 'machine', root: runnerRoot, runnerExecution: true,
      repo: runnerRoot, agent: `pullboard-ssh-${spec.id}`,
      landing: spec.landing === true, itemCheck: spec.itemCheck === true,
      diagnostic: spec.diagnostic === true, browser: spec.browserRequired, timing: spec.timing === true,
      browserCapacityProvider: () => browserCapacity,
      item: spec.item ?? '', kind: spec.kind ?? 'remote-command',
      onWait: () => assertTransportLive(S),
    }, machineHomePath));
    phases.mark('prepareMs');
    gui = guiSession();
    if (spec.guiRequired && gui !== true) throw new Refused('RUNNER_GUI_SESSION_REQUIRED', 'log in to a GUI session on this runner or keep GUI-marked files local');
    const startLoad = sampleRunnerLoad({ diskIo: diskIoSetting() });
    lease.executionAdmission = { admittedAt: lease.admittedAt, slots: gateCapacity, load: { start: startLoad, end: null } };
    const canonicalMachineHome = machineHomePath;
    tracker = createDescendantTracker(runDirectory, {
      tick: () => reportCleanupTimeout(S), timedOut: () => S.cleanupTimedOut,
      warn: reason => process.stderr.write(`PULLBOARD_RUNNER_CLEANUP_UNVERIFIED ${S.workerId} ${reason}\n`),
    });
    S.cleanupDetails = tracker.cleanupState;
    S.activeDescendantTracker = tracker;
    runtimeCapture = captureTestRuntimes(scopedEnvironment(S, privateHome, temporary, canonicalMachineHome, lease, api, tracker.nodeOptions));
    const env = runtimeCapture.env;
    setupStep = 'source history checkout';
    phases.mark('sourceMs');
    sourceMetrics = await checkoutHistory(S, api, runnerRoot, root, packFile, spec, env);
    phases.mark('dependenciesMs');
    if (!spec.trustedMode) {
      setupStep = 'committed dependencies';
      dependencies = await installDependencies(S, root, runnerRoot, env, tracker, api);
    }
    setupStep = 'command start';
    const browserRefusal = join(runDirectory, BROWSER_REFUSAL_FILE);
    const resultStore = join(runnerRoot, 'test-results', spec.repoId);
    if (spec.testResults) importTestResults(resultStore, spec.testResults.packet, spec.testResults.inputKeys);
    // A request without an exchange comes from a caller that opted out of reuse: run every file, read no store.
    const commandEnv = { ...env, ...(analysisArtifactPath ? { PULLBOARD_RUNNER_ANALYSIS_ARTIFACT: analysisArtifactPath } : {}), ...(spec.testResults ? { [TEST_RESULT_STORE_ENV]: resultStore,
      [TEST_RESULT_ORIGIN_ENV]: spec.testResults.origin, [TEST_RESULT_REQUEST_ENV]: spec.id, PULLBOARD_TEST_STAGE: spec.testResults.stage } : { PULLBOARD_TEST_REUSE: '0' }),
      // An audit-coverage run always executes every file, whatever the exchange holds.
      ...auditAdapterEnvironment(spec.auditCoverage),
      ...(spec.auditCoverage ? { PULLBOARD_AUDIT_COVERAGE_REPORTER: fileURLToPath(new URL('../../../../../packages/gate/src/logic/reporter/coverage.js', import.meta.url)), PULLBOARD_TEST_REUSE: '0' } : {}),
      PULLBOARD_TEST_CACHE_TOOLING: spec.tooling.sha256,
      ...(spec.timingRunId ? { PULLBOARD_TIMING_RUN_ID: spec.timingRunId } : {}),
      PULLBOARD_LANDING_RUN: spec.landing === true ? '1' : '0', [api.BROWSER_REFUSAL_FILE_ENV]: browserRefusal, ...(typeof spec.browserByLaunch === 'boolean' ? { PULLBOARD_TEST_BROWSER_BY_LAUNCH: spec.browserByLaunch ? '1' : '0' } : {}), PULLBOARD_LANDING_WAIVERS: JSON.stringify(spec.landing === true ? spec.waivers ?? [] : []) };
    if (!analysisArtifactPath) delete commandEnv.PULLBOARD_RUNNER_ANALYSIS_ARTIFACT;
    process.stderr.write(`PULLBOARD_RUNNER_READY ${spec.id}\n`);
    phases.mark('commandMs');
    // A ticket runs its hand-off stages here, on the runner; any other job runs its one command.
    final = { ...(spec.handoff ? await runHandoffJob(spec, root, runnerRoot) : spec.trustedMode ? await runPrivateCheck(S, spec, root, commandEnv, sink, tracker) : await runCommand(S, spec, root, commandEnv, sink, tracker)), root };
    if (spec.testResults) final.testResults = packTestResults(selectedTestResults(resultStore, spec.testResults.inputKeys));
    if (final.code !== 0 && fs.exists(browserRefusal)) final.browserRefused = true;
  } catch (error) {
    const refused = setupRefusalCode(error);
    const message = refused ? `${safeSetupMessage(S, error, setupStep)} [${refused}]` : safeSetupMessage(S, error, setupStep);
    if (!S.transportLost && !spec?.trustedMode) await sink.write(`${message}\n`);
    final = { code: 1, signal: S.transportLost ? 'SIGHUP' : null, error: message, root: '', ...(refused ? { refused } : {}),
      ...(spec?.trustedMode ? { trustedMode: { kind: 'private-check', version: 1, requestSha256: spec.trustedMode.sha256,
        phases: { install: null, check: null }, guard: spec.trustedMode.guard ? { applied: false, problem: message } : null,
        sourceUnchanged: false, problem: { stage: 'check', message } } } : {}) };
  } finally {
    orphanWatch.stop();
    phases.mark('cleanupMs');
    // The result goes out first: the controller returns on this receipt while cleanup below continues here (#2538).
    await reportResult();
    beginCleanup(S);
    S.cleanupStage = 'final descendants';
    if (tracker) await tracker.stopDescendants();
    S.cleanupStage = 'final process groups';
    await drainAllOwned(S);
    if (S.recycleSource) {
      S.cleanupStage = 'source checkout return';
      await S.recycleSource();
      await drainAllOwned(S);
    }
    if (tracker) {
      S.cleanupStage = 'final verification';
      await tracker.verifyAfterGroups();
      tracker.stopMonitoring();
      S.activeDescendantTracker = null;
    }
    if (recoveryRoot && !S.transportLost && !S.cleanupTimedOut && Date.now() < S.cleanupDeadline) {
      S.cleanupStage = 'Chrome clone sweep';
      try { await scheduledChromeCloneSweep(recoveryRoot, { deadline: S.cleanupDeadline }); }
      catch { process.stderr.write('PULLBOARD_CHROME_CLONE_SWEEP unavailable\n'); }
    }
    if (lease) {
      S.cleanupStage = 'lease release';
      await releaseDrainedLease(S, lease);
    }
    const custody = tracker?.cleanupState();
    const drained = S.ownedChildren.size === 0 && (!custody || !custody.uncertain && !custody.censusFailure && !custody.pending.length && !custody.live.length);
    if (recoveryRoot && runDirectory && drained) {
      try { recordRunnerCompletion(recoveryRoot, spec.recovery, basename(runDirectory)); }
      catch { /* Missing durable custody keeps recovery unavailable. */ }
    }
    S.cleanupStage = 'job files';
    // No filesystem writes follow final removal; health separately requires this exact directory to be absent.
    if (runDirectory && (!S.cleanupTimedOut || drained)) { try { fs.rm(runDirectory, { recursive: true, force: true }); } catch { /* Best effort: health separately requires this exact directory to be absent. */ } }
  }
  // Past the receipt a slow or failed cleanup is only a leftover for the sweep (#2525); it never turns the result red.
  clearTimeout(S.cleanupTimer);
  clearTimeout(S.phaseCleanupTimer);
  orphanWatch.finish();
  // The result is already delivered, so the cleanup budget no longer applies; sweep leftovers after each job.
  if (recoveryRoot && api) await sweepRunnerDiskForWorker(recoveryRoot, S.workerId, Date.now() + 60_000, api, environmentAdapter().get('PULLBOARD_MACHINE_HOME') ?? join(userInfo().homedir, '.pullboard'));
  process.exitCode = S.resultSent ? 0 : 1;
  stopReading();
}
