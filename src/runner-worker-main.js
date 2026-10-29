/** Execute one remote job end to end; stdout is reserved for raw command bytes and stderr for one receipt [C7]. */
import { checkoutHistory } from './runner-worker-checkout.js';
import { installDependencies } from './runner-worker-checkout.js';
import { beginCleanup } from './runner-worker-cleanup.js';
import { releaseDrainedLease } from './runner-worker-cleanup.js';
import { reportCleanupTimeout } from './runner-worker-cleanup.js';
import { outputSink } from './runner-worker-command.js';
import { runCommand } from './runner-worker-command.js';
import { runPrivateCheck } from './runner-worker-command.js';
import { acquireResourceApi } from './runner-worker-environment.js';
import { loadResourceApi } from './runner-worker-environment.js';
import { registeredCapacity } from './runner-worker-environment.js';
import { scopedEnvironment } from './runner-worker-environment.js';
import { assertTransportLive } from './runner-worker-process.js';
import { drainAllOwned } from './runner-worker-process.js';
import { installSignalCustody } from './runner-worker-process.js';
import { receipt } from './runner-worker-receipt.js';
import { safeSetupMessage } from './runner-worker-receipt.js';
import { setupRefusalCode } from './runner-worker-receipt.js';
import { stopReading } from './runner-worker-receipt.js';
import { readSpec } from './runner-worker-spec.js';
import { captureTestRuntimes } from './execution-environment.js';
import { guiSession } from './gui-session.js';
import { Refused } from './refused.js';
import { createDescendantTracker } from './runner-custody.js';
import { sampleRunnerLoad } from './runner-load.js';
import { pinSourceCacheJob } from './runner-source-cache.js';
import { recordRunnerCompletion } from './runner-transport.js';
import { recordRunnerOwner } from './runner-transport.js';
import { TEST_RESULT_ORIGIN_ENV } from './test-result-store.js';
import { TEST_RESULT_STORE_ENV } from './test-result-store.js';
import { importTestResults } from './test-result-store.js';
import { packTestResults } from './test-result-store.js';
import { selectedTestResults } from './test-result-store.js';
import { startRunnerPhases } from './timing.js';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Execute one remote job end to end; stdout is reserved for raw command bytes and stderr for one receipt. */
export async function main(S) {
  installSignalCustody(S);
  const spec = await readSpec(S);
  S.workSpecAccepted = true;
  S.workerId = spec.id;
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
  let final = { code: 1, signal: null, root: '' };
  try {
    const runnerHome = isAbsolute(process.env.HOME || '') ? process.env.HOME : userInfo().homedir;
    const runnerRoot = spec.root ?? join(runnerHome, '.pullboard-runner');
    recoveryRoot = runnerRoot;
    S.setupPrivatePaths.add(runnerRoot);
    mkdirSync(runnerRoot, { recursive: true, mode: 0o700 });
    S.setupPrivatePaths.add(realpathSync(runnerRoot));
    chmodSync(runnerRoot, 0o700);
    const configuredMachineHome = process.env.PULLBOARD_MACHINE_HOME;
    if (configuredMachineHome !== undefined && !isAbsolute(configuredMachineHome)) throw new Error('machine home is invalid');
    const machineHomePath = configuredMachineHome ?? join(runnerHome, '.pullboard');
    S.setupPrivatePaths.add(machineHomePath);
    setupStep = 'trusted resource API';
    api = loadResourceApi(spec.runtime);
    // The registration travels with the job; this machine's own settings never size a runner (#1066).
    const { gateCapacity, browserCapacity } = registeredCapacity(api, spec, runnerRoot, machineHomePath);
    setupStep = 'job directories';
    const base = join(runnerRoot, 'jobs');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    chmodSync(base, 0o700);
    runDirectory = mkdtempSync(join(base, `${spec.id}-`));
    S.cleanupDirectory = runDirectory;
    recordRunnerOwner(runDirectory);
    const root = join(runDirectory, 'checkout');
    const privateHome = join(runDirectory, 'home');
    const temporary = join(runDirectory, 'tmp');
    mkdirSync(root, { mode: 0o700 }); mkdirSync(privateHome, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 });
    writeFileSync(join(privateHome, 'npm-userconfig'), '', { mode: 0o600 });
    writeFileSync(join(privateHome, 'npm-globalconfig'), '', { mode: 0o600 });
    pinSourceCacheJob(runDirectory, spec);
    const packFile = join(runDirectory, 'source.pack');
    setupStep = 'runner gate admission';
    phases.mark('capacityWaitMs');
    lease = await acquireResourceApi(api, {
      name: 'gate', capacity: gateCapacity, scope: 'machine', root: runnerRoot, runnerExecution: true,
      repo: runnerRoot, agent: `pullboard-ssh-${spec.id}`,
      landing: spec.landing === true, itemCheck: spec.itemCheck === true,
      diagnostic: spec.diagnostic === true, browser: spec.browserRequired, timing: spec.timing === true,
      browserCapacityProvider: () => browserCapacity,
      item: spec.item ?? '', kind: spec.kind ?? 'remote-command',
      onWait: () => assertTransportLive(S),
    }, machineHomePath);
    phases.mark('prepareMs');
    gui = guiSession();
    if (spec.guiRequired && gui !== true) throw new Refused('RUNNER_GUI_SESSION_REQUIRED', 'log in to a GUI session on this runner or keep GUI-marked files local');
    const startLoad = sampleRunnerLoad();
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
      await installDependencies(S, root, runnerRoot, env, tracker);
    }
    setupStep = 'command start';
    const browserRefusal = join(runDirectory, 'browser-refusal.json');
    const resultStore = join(runnerRoot, 'test-results', spec.repoId);
    if (spec.testResults) importTestResults(resultStore, spec.testResults.packet, spec.testResults.inputKeys);
    // A request without an exchange comes from a caller that opted out of reuse: run every file, read no store.
    const commandEnv = { ...env, ...(spec.testResults ? { [TEST_RESULT_STORE_ENV]: resultStore,
      [TEST_RESULT_ORIGIN_ENV]: spec.testResults.origin, PULLBOARD_TEST_STAGE: spec.testResults.stage } : { PULLBOARD_TEST_REUSE: '0' }),
      // An audit-coverage run always executes every file, whatever the exchange holds.
      ...(spec.auditCoverage ? { PULLBOARD_AUDIT_COVERAGE_REPORTER: fileURLToPath(new URL('./audit-coverage-reporter.js', import.meta.url)), PULLBOARD_TEST_REUSE: '0' } : {}),
      PULLBOARD_TEST_CACHE_TOOLING: spec.tooling.sha256,
      ...(spec.timingRunId ? { PULLBOARD_TIMING_RUN_ID: spec.timingRunId } : {}),
      PULLBOARD_LANDING_RUN: spec.landing === true ? '1' : '0', [api.BROWSER_REFUSAL_FILE_ENV]: browserRefusal, ...(typeof spec.browserByLaunch === 'boolean' ? { PULLBOARD_TEST_BROWSER_BY_LAUNCH: spec.browserByLaunch ? '1' : '0' } : {}), PULLBOARD_LANDING_WAIVERS: JSON.stringify(spec.landing === true ? spec.waivers ?? [] : []) };
    process.stderr.write(`PULLBOARD_RUNNER_READY ${spec.id}\n`);
    phases.mark('commandMs');
    final = { ...(spec.trustedMode ? await runPrivateCheck(S, spec, root, commandEnv, sink, tracker) : await runCommand(S, spec, root, commandEnv, sink, tracker)), root };
    if (spec.testResults) final.testResults = packTestResults(selectedTestResults(resultStore, spec.testResults.inputKeys));
    if (final.code !== 0 && existsSync(browserRefusal)) final.browserRefused = true;
  } catch (error) {
    const refused = setupRefusalCode(error);
    const message = refused ? `${safeSetupMessage(S, error, setupStep)} [${refused}]` : safeSetupMessage(S, error, setupStep);
    if (!S.transportLost && !spec?.trustedMode) await sink.write(`${message}\n`);
    final = { code: 1, signal: S.transportLost ? 'SIGHUP' : null, error: message, root: '', ...(refused ? { refused } : {}),
      ...(spec?.trustedMode ? { trustedMode: { kind: 'private-check', version: 1, requestSha256: spec.trustedMode.sha256,
        phases: { install: null, check: null }, guard: spec.trustedMode.guard ? { applied: false, problem: message } : null,
        sourceUnchanged: false, problem: { stage: 'check', message } } } : {}) };
  } finally {
    phases.mark('cleanupMs');
    beginCleanup(S);
    S.cleanupStage = 'final descendants';
    if (tracker) await tracker.stopDescendants();
    S.cleanupStage = 'final process groups';
    await drainAllOwned(S);
    if (tracker) {
      S.cleanupStage = 'final verification';
      await tracker.verifyAfterGroups();
      tracker.stopMonitoring();
      S.activeDescendantTracker = null;
    }
    if (lease) {
      S.cleanupStage = 'lease release';
      try {
        if (lease.executionAdmission) {
          const endLoad = sampleRunnerLoad();
          final.executionAdmission = { ...lease.executionAdmission, ...lease.timingEvidence(), finishedAt: endLoad.at, load: { ...lease.executionAdmission.load, end: endLoad } };
        }
      } finally { await releaseDrainedLease(S, lease); }
    }
    final.testRuntimes = runtimeCapture?.finish() ?? null;
    const custody = tracker?.cleanupState();
    const drained = S.ownedChildren.size === 0 && (!custody || !custody.uncertain && !custody.censusFailure && !custody.pending.length && !custody.live.length);
    if (recoveryRoot && runDirectory && drained) {
      try { recordRunnerCompletion(recoveryRoot, spec.recovery, basename(runDirectory)); }
      catch { /* Missing durable custody keeps recovery unavailable. */ }
    }
    S.cleanupStage = 'job files';
    // No filesystem writes follow final removal; health separately requires this exact directory to be absent.
    if (runDirectory && (!S.cleanupTimedOut || drained)) { try { rmSync(runDirectory, { recursive: true, force: true }); } catch { /* Best effort: health separately requires this exact directory to be absent. */ } }
  }
  if (S.transportLost || S.cleanupTimedOut) { clearTimeout(S.cleanupTimer); clearTimeout(S.phaseCleanupTimer); process.exitCode = 1; stopReading(); return; }
  S.cleanupStage = 'result receipt';
  final.executionPhases = phases.finish();
  final.sourcePreparation = sourceMetrics;
  await receipt(spec, { ...final, gui }, sink);
  clearTimeout(S.cleanupTimer);
  clearTimeout(S.phaseCleanupTimer);
  process.exitCode = 0;
  stopReading();
}
