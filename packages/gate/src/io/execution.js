import { auditAdapterEnvironment } from '../../../kernel/index.js';
import { requireTestTierAccount } from './test/tier/selection.js';
import { landingShardCount } from './test/concurrency.js';
import { landingShardable } from './shards/landing.js';
import { landingShardExecution } from './shards/landing.js';
import { runShellAsync } from './run/shell.js';
import { gateStages } from './stages.js';
import { stagedScript } from './stages.js';
import { readStages } from './stages.js';
import { readPipes } from './stages.js';
import { proofSourceAt } from './observation.js';
import { testValueProfile } from './observation.js';
import { shadowOfRun } from './run/shadow.js';
import { quarantineRunVerdict } from './quarantine.js';
import { sourcePreparationFields } from '../../light.js';
import { gateRunnerAdmission } from '../../../config/index.js';
import { loadMachineSettings } from '../../../config/index.js';
import { gitChildEnv } from '../../../git/index.js';
import { invalidateGitFacts } from '../../../git/index.js';
import { keepHeartbeatWhileBlocked } from '../../../resources/index.js';
/** Concern-specific gate stage; public callers keep the gate facade. */
import {
  TIMING_RUN_ID_ENV,
  suiteTimingFromOutput,
  timingAccountingStages,
  observedRunTiming,
  timingSource as timingSourceForReceipt,
  sameTimingSource,
} from './run/timing.js';
import {
  settleReceipt,
  requireGateExecutionServices,
  withGateSlot,
} from './slot.js';
import {
  policyAt,
} from '../../../sandbox/index.js';
import {
  COLLECTION_ID_ENV,
  parseCollectionReports,
} from './run/receipt.js';
import {
  retainTestValueTimings,
} from './test/value/timing.js';
import {
  VALUE_GATE,
  valueGateCommand,
} from './test/placement.js';
import {
  projectNeedsGui,
} from './gui/admission.js';
import {
  spawn,
} from 'node:child_process';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path';
import {
  availableParallelism,
  freemem,
  loadavg,
  tmpdir,
} from 'node:os';
import {
  fileURLToPath,
} from 'node:url';
import {
  captureTestRuntimes,
  executionEnvironment,
} from '../../../sandbox/index.js';
import { testRuntimeEnvironment } from '../../../verify/light.js';
import {
  gitPath,
  headCommit,
  headTree,
  isClean,
  tryGit,
  untracked,
} from '../../../git/index.js';
import {
  recordGateRun,
} from './control.js';
import {
  receiptBody,
  receiptFields,
  receiptStore,
} from './run/receipt.js';
import {
  committedTest,
  singleFileTapOutcomes,
  tapTests,
} from './tap.js';
import { readTestOutcomes } from './test/outcomes.js';
import { cacheProfile } from './test/account.js';
import { committedTestOutcomes } from './test/outcomes.js';
import {
  frozenCheck,
  mainPolicy,
} from '../../../sandbox/index.js';
import {
  proofCounts,
  observedFailureSignatures,
} from '../../../verify/index.js';
import {
  logLines,
} from './timing.js';
import {
  secretsIn,
} from '../../../commits/index.js';
import {
  Refused,
} from '../../../kernel/index.js';
import {
  missingGate,
} from './config.js';
import {
  GATE_SLOT_HELD_ENV,
  gateSlotEnvironment,
  requiredExecutorOf,
} from '../../../resources/index.js';
import {
  timingFromOutput,
  timingRunner,
} from './timing.js';
import {
  landingShardProfile,
  RELEASE_EXECUTORS_ENV,
  releaseParticipation,
} from './run/receipt.js';
import {
  releaseParticipationFields,
  releaseParticipationDigest,
} from './release/receipt.js';
import {
  runShell,
} from './run/shell.js';
import {
  writeTimingProfile,
} from './output.js';
import {
  sandboxBlockedOperation,
} from '../../../sandbox/index.js';
const STAMP = 'pullboard-gate-green';
const LOG = 'pullboard-gate.log';
const LANDING_RUN_ENV = 'PULLBOARD_LANDING_RUN';
const LANDING_COLLECT_ALL_ENV = 'PULLBOARD_LANDING_COLLECT_ALL';
// Live person waivers, as {kind, test}, so a landing run does not stop early on a waived failure.
const LANDING_WAIVERS_ENV = 'PULLBOARD_LANDING_WAIVERS';
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
export function safeLog(output) {
  return output.split('\n').map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > 64 * 1024) return '[redacted output line exceeds 64 KiB safe-scan limit]';
    const findings = secretsIn([{ path: 'item check output', line: index + 1, text: line }]);
    return findings.length ? `[redacted ${findings.map(finding => finding.slice(0, finding.lastIndexOf(' at '))).join(', ')}]` : line;
  }).join('\n');
}

/** Run the unchanged caller command and profile only timings already present in its output.
 * @param {string} root
 * @param {string} command
 * @param {{ waitMs?: number, artifactDirectory?: string, artifactPrefix?: string, persistLog?: boolean, profileFile?: string, pipefail?: boolean, gateSlotHeld?: boolean, gateLease?: object, landing?: boolean, collectAll?: boolean, stages?: boolean, timeoutMs?: number, waivers?: Array<{ kind: string, test: string }>, pinnedSource?: { head: string, tree: string } }} [options] - pinnedSource is the exact commit a runner runs in place of this checkout's HEAD.
 */
function* profiledExecution(root, command, { waitMs = 0, artifactDirectory, artifactPrefix = 'pullboard-gate', persistLog = false, profileFile, pipefail = false, gateSlotHeld = false, gateLease, landing = false, collectAll = false, releaseRequest, stages = false, waivers = [], timeoutMs, auditCoverage = false, signal, pinnedSource } = {}) {
  const proofSource = gateLease?.proof || gateLease?.quarantines?.length ? proofSourceAt(root, null, committedTree) : null;
  // A pinned runner source is the exact commit the runner received, never this checkout's HEAD [C7,#3323].
  const timingSourceBefore = stages ? pinnedSource ?? timingSourceForReceipt(root) : null;
  const directory = artifactDirectory ?? dirname(gitPath(root, LOG));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const profilePath = profileFile ?? join(directory, `${artifactPrefix}-${id}.profile.json`);
  const logPath = persistLog ? join(directory, `${artifactPrefix}-${id}.log`) : null;
  const started = Date.now();
  const collectionId = landing && collectAll ? randomUUID() : null;
  // Continuation only prevents early cancellation; the board-bound verdict is computed afterwards.
  const continuation = [...waivers, ...(landing ? gateLease?.quarantines ?? [] : []).map(row => ({ kind: 'case', test: row.name, file: row.file }))];
  const inherited = {
    ...(gateLease?.testTiers ? { NODE_TEST_CONTEXT: undefined } : {}),
    [TIMING_RUN_ID_ENV]: id,
    ...auditAdapterEnvironment(auditCoverage),
    ...(auditCoverage ? { PULLBOARD_AUDIT_COVERAGE_REPORTER: fileURLToPath(new URL('../logic/reporter/coverage.js', import.meta.url)), PULLBOARD_TEST_REUSE: '0' } : {}),
    ...(gateLease && !gateLease.runner ? gateSlotEnvironment(gateLease) : gateSlotHeld ? { [GATE_SLOT_HELD_ENV]: '1' } : {}),
    [LANDING_RUN_ENV]: landing ? '1' : '0',
    [LANDING_COLLECT_ALL_ENV]: landing && collectAll ? '1' : '0',
    [COLLECTION_ID_ENV]: collectionId ?? '',
    [RELEASE_EXECUTORS_ENV]: releaseRequest ? JSON.stringify(releaseRequest) : '',
    [LANDING_WAIVERS_ENV]: landing ? JSON.stringify(continuation) : '[]',
    // A reused test result names the stage that ran it (#1045).
    PULLBOARD_TEST_STAGE: gateLease?.receiptKind ?? (landing ? 'land' : 'gate'),
  };
  // The registered worker returns the same complete stage/component accounting as a local run.
  gateLease?.tracker?.mark('runAt');
  const remoteCommand = landing && collectAll ? `(export ${LANDING_COLLECT_ALL_ENV}=1 ${COLLECTION_ID_ENV}=${collectionId}\n${command}\n)` : command;
  const run = yield { root, command, remoteCommand, gateLease,
    remoteOptions: gateLease?.runner ? { runner: gateLease.runner, source: gateLease.source, runnerWaitDeadline: gateLease.runnerWaitDeadline, runnerStartupMs: gateLease.runnerStartupMs, signal,
    browser: gateLease.browser, byLaunch: gateLease.browserByLaunch, pipefail, stages, waivers: landing ? continuation : [], metadata: { ...(gateLease.runMetadata ?? {}), landing, auditCoverage,
      testStage: inherited.PULLBOARD_TEST_STAGE, timingRunId: id, ...(timeoutMs ? { timeoutMs } : {}) } } : null,
    localOptions: { pipefail, env: inherited, stages, timeoutMs, captureRuntimes: Boolean(gateLease), signal } };
  gateLease?.tracker?.mark('ranAt');
  if (gateLease) {
    gateLease.environment = run.environment ?? null;
    gateLease.gui = run.executionCapabilities?.gui ?? null;
    gateLease.executionAdmission = run.executionAdmission ?? null;
    gateLease.executionPhases = run.executionPhases ?? null;
    gateLease.sourcePreparation = sourcePreparationFields(run.sourcePreparation);
  }
  const sandboxBlocked = run.isGreen ? null : run.sandboxBlocked ?? (run.executionRunner
    // The controller cannot realpath remote files; retain the network denial signal without treating remote paths as local paths.
    ? sandboxBlockedOperation(root, run.output, { includeFilePaths: false })
    : sandboxBlockedOperation(root, run.output));
  const testOutcomes = committedTestOutcomes(root, proofSource?.head ?? pinnedSource?.head ?? headCommit(root),
    readTestOutcomes(safeLog(run.output ?? ''), id) ?? singleFileTapOutcomes(command, safeLog(run.output ?? '')), tryGit);
  const profiledRun = { ...run, sandboxBlocked, ...(testOutcomes ? { testOutcomes } : {}) };
  if (logPath) writeFileSync(logPath, safeLog(run.output), { mode: 0o600 });
  const profile = writeTimingProfile(profilePath, {
    ...runTiming(profiledRun, command, root), ...(testOutcomes ? { testOutcomes } : {}), ...cacheProfile(run.output),
    waitMs: Math.max(0, Math.round(waitMs)), wallMs: Math.max(0, Date.now() - started), receipt: settleReceipt(gateLease),
  });
  const collectionReport = collectionId ? parseCollectionReports(run.output, { id: collectionId, scope: 'suite', requireComplete: false }) : null;
  const timingSourceAfter = stages ? pinnedSource ?? timingSourceForReceipt(root) : null;
  const executionSource = run.executionSource && { head: run.executionSource.commit, tree: run.executionSource.tree };
  const accountingSource = sameTimingSource(timingSourceBefore, timingSourceAfter)
    && run.executionSourceUnchanged !== false && (!gateLease?.runner || Boolean(executionSource))
    && (!executionSource || sameTimingSource(timingSourceBefore, executionSource))
    ? timingSourceBefore : null;
  const rawResult = { ...profiledRun, id, profile, profilePath, logPath,
    ...(stages ? { stages: timingAccountingStages(run.stages, id, accountingSource, { collectionId: collectionId ?? id }) } : {}),
    suiteTiming: suiteTimingFromOutput(run.output, id, run.executionSource
      ? { head: run.executionSource.commit, tree: run.executionSource.tree } : timingSourceForReceipt(root)),
    ...(releaseRequest ? { releaseParticipation: releaseParticipation(run.output, releaseRequest.id) } : {}),
    ...(collectAll ? { collectAllComplete: collectionReport?.complete === true, collectionReport,
      cleanupVerified: collectionReport?.cleanupVerified === true } : {}) };
  const result = quarantineRunVerdict(rawResult, gateLease?.quarantines, { root,
    sourceClean: cleanProofSource(root, proofSource, rawResult, gateLease) });
  if (result.blockingVerdict) result.profile = writeTimingProfile(profilePath, { ...profile, blockingVerdict: result.blockingVerdict });
  const proofReceiptId = gateLease?.proof && leaveProofReceipt(root, command, result, proofSource, gateLease.proof, gateLease);
  return { ...result, ...(proofReceiptId ? { proofReceiptId } : {}) };
}

/** The same clean local/remote source boundary governs both raw provenance and interpreted verdicts. */
function cleanProofSource(root, before, run, lease, pinned = false) {
  if (!before) return false;
  const after = pinned ? before : proofSourceAt(root, null, committedTree);
  const source = run.executionSource ?? run.profile?.executionSource;
  return before.clean && after.clean && before.head === after.head && before.tree === after.tree
    && run.executionSourceUnchanged !== false && (!source || source.commit === before.head && source.tree === before.tree)
    && (!lease?.runner || Boolean(source));
}

/** A computed exception never overwrites what the process actually returned. */
function rawRunGreen(run) { return run.rawIsGreen ?? run.isGreen ?? run.state === 'pass'; }

/** The private gate writer records process results, never provenance supplied by a CLI argument. */
function leaveProofReceipt(root, command, run, before, context, lease) {
  try {
    if (!before || run.sandboxBlocked || run.exitCode === undefined) return null;
    const store = receiptStore(root);
    if (!store) return null;
    const sourceClean = cleanProofSource(root, before, run, lease, Boolean(context.commit));
    const testRuntimes = run.testRuntimes ?? run.profile?.testRuntimes ?? null;
    // A run with no captured test workers still observed its executor: record that host, never an invented one [C7,#2662].
    const executor = run.environment;
    const executorKnown = executor && ['node', 'platform', 'arch'].every(key => typeof executor[key] === 'string' && executor[key]);
    const environment = testRuntimes ? testRuntimeEnvironment(testRuntimes)
      : executorKnown ? { node: executor.node, platform: executor.platform, arch: executor.arch } : null;
    const remote = run.executionRunner ?? run.profile?.executionRunner;
    const localLoad = { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) };
    // A submit's pinned main (lease.pinnedMain) is the only main its phases may record (#1777).
    let main = lease?.pinnedMain ?? null;
    if (main === null) try { main = mainPolicy(root).commit; } catch { /* An unavailable policy remains unknown in this execution record. */ }
    const failures = rawRunGreen(run) ? [] : run.quarantineFailures ?? tapTests(run.output ?? '', run.executionRoot ?? root)
      .filter(row => !row.passed && !row.skip && row.file && row.type !== 'suite'
        && !['subtestsFailed','cancelledByParent','testAborted'].includes(row.failureType)).slice(0, 500).map(({ file, name }) => ({ file, name }));
    let signed = null;
    try { signed = observedFailureSignatures({ version: lease?.signatureCapture?.version,
      failures: !rawRunGreen(run) && run.stages ? lease?.signatureCapture?.derive(run, root) : null }, failures); }
    catch { /* Optional diagnostics cannot erase the raw native receipt. */ }
    const shadow = shadowOfRun(root, { head: before.head, main, green: rawRunGreen(run), failures });
    const receipt = receiptFields({ version: 2, id: randomUUID(), kind: context.kind,
      tree: before.tree, head: before.head, main, command: createHash('sha256').update(command).digest('hex'),
      green: rawRunGreen(run), failures,
      ...(signed ? { failureSignatures: signed } : {}),
      load: run.executionLoad ?? (remote || lease?.runner ? null : localLoad), at: new Date().toISOString(),
      ...(sourceClean && run.testOutcomes ? { testOutcomes: run.testOutcomes } : {}),
      ...(sourceClean && run.blockingVerdict ? { blockingVerdict: run.blockingVerdict } : {}),
      ...(shadow ? { shadow } : {}),
      proof: { item: context.item, frozenDigest: context.frozenDigest ?? null, seat: context.seat,
        environment, testRuntimes, runner: remote ?? (lease?.runner ? null
          : run.profile?.receipt?.runner?.id ?? lease?.receipt?.runner?.id ?? lease?.localDescriptor?.id ?? null), exitCode: run.exitCode,
        counts: run.proofCounts ?? proofCounts(run.outputPath ? logLines(run.outputPath) : run.output ?? ''),
        durationMs: Math.max(0, Math.round(run.remoteWallMs ?? run.profile?.wallMs ?? run.seconds * 1000)), sourceClean,
        ...(context.submitPhase ? { submitPhase: context.submitPhase } : {}),
        ...(context.submitAdmission ? { submitAdmission: context.submitAdmission } : {}),
        ...(context.submitReuse ? { submitReuse: true, submitReusePlan: context.submitReusePlan } : {}),
        ...(context.diagnosticAdmission ? { diagnosticAdmission: context.diagnosticAdmission } : {}),
        ...(Array.isArray(run.shards) ? { shards: run.shards } : {}) } });
    if (!receipt) return null;
    mkdirSync(store, { recursive: true, mode: 0o700 });
    writeFileSync(join(store, `${receipt.id}.json`), receiptBody(receipt), { flag: 'wx', mode: 0o600 });
    retainTestValueTimings(store, receipt.id, testValueProfile(root, run));
    if (lease) {
      lease.proofReceiptIds ??= [];
      lease.proofReceiptIds.push(receipt.id);
    }
    return receipt.id;
  } catch { return null; /* A missing receipt is refused by the CLI before it records a verdict. */ }
}

/** Execute a private immutable check before the gate writes its provenance. */
export function runFrozenProof(root, item, { gateLease, waitMs = 0, diagnostic = false } = {}, { checkAtCommit }) {
  if (diagnostic && (gateLease?.proof?.kind !== 'submit' || !gateLease.proof.diagnosticAdmission || item.item_id !== gateLease.proof.item)) throw new Refused('PROOF_RUN_UNBOUND', 'a diagnostic needs its actual admitted Submit item');
  const context = diagnostic
    ? { item: item.item_id, frozenDigest: null, seat: gateLease.proof.seat, kind: 'check', commit: item.item_commit, submitPhase: 'diagnostic', diagnosticAdmission: gateLease.proof.diagnosticAdmission }
    : { item: item.item_id, frozenDigest: item.item_frozen_digest ?? null,
      seat: gateLease?.proof?.seat, kind: 'verdict', commit: item.item_commit };
  const before = proofSourceAt(root, item.item_commit, committedTree);
  const outcomeId = randomUUID();
  if (gateLease) gateLease.testOutcomeRunId = outcomeId;
  let result = checkAtCommit(root, item, { gateLease, waitMs });
  const testOutcomes = result.executed && result.executionSourceUnchanged !== false
    ? committedTestOutcomes(root, item.item_commit, readTestOutcomes(result.outputPath ? logLines(result.outputPath) : result.output ?? '', outcomeId)
      ?? singleFileTapOutcomes(result.executionCommand ?? frozenCheck(item), result.outputPath ? [...logLines(result.outputPath)].join('\n') : result.output ?? ''), tryGit) : null;
  if (testOutcomes) {
    result.testOutcomes = testOutcomes;
    if (result.profilePath) result.profile = { ...writeTimingProfile(result.profilePath, { ...result.profile, testOutcomes }), profilePath: result.profilePath };
  }
  // Coverage is checked after binding the native test account; reporter timing is optional.
  if (result.testTiers) requireTestTierAccount(result, result.testTiers.units);
  result = quarantineRunVerdict(result, gateLease?.quarantines, { root,
    sourceClean: cleanProofSource(root, before, result, gateLease, true), privateCommand: result.executionCommand ?? frozenCheck(item), outcomeId,
    source: { head: before.head, tree: before.tree } });
  const id = result.executed ? leaveProofReceipt(root, result.executionCommand ?? frozenCheck(item), result, before, context, gateLease) : null;
  return { ...result, ...(id ? { proofReceiptId: id } : {}) };
}

/** Execute the shared profiled plan synchronously, preserving every existing receipt field. */
export function runProfiledShell(root, command, options) {
  const execution = profiledExecution(root, command, options);
  try {
    const { value: plan } = execution.next();
    const { gateLease } = plan;
    // The blocked loop cannot fire the lease's heartbeat timer; a helper keeps it until the run's own timeout (#3130).
    const stopHeartbeat = keepHeartbeatWhileBlocked(gateLease, { timeoutMs: plan.localOptions?.timeoutMs });
    let run;
    try {
      run = gateLease?.runner
        ? gateLease.executionServices.runners.runOnRunner(root, plan.remoteCommand, plan.remoteOptions)
        : runShell(root, command, plan.localOptions);
    } finally { stopHeartbeat(); }
    return execution.next(run).value;
  } finally { execution.return(); }
}

/** Run the same plan concurrently; its source, profiles, quarantine verdict and receipts are unchanged. */
export async function runProfiledShellAsync(root, command, options) {
  const execution = profiledExecution(root, command, options);
  try {
    const { value: plan } = execution.next();
    const { gateLease } = plan;
    const run = gateLease?.runner
      ? await gateLease.executionServices.runners.runOnRunnerAsync(root, plan.remoteCommand, plan.remoteOptions)
      : await runShellAsync(root, command, plan.localOptions);
    return execution.next(run).value;
  } finally { execution.return(); }
}

/**
 * Run one profiled plan whose execution the caller supplies: the plan names the whole command, so its profile, source
 * checks and one proof receipt are the same as runProfiledShellAsync's, while `execute` may run that command as shards
 * across several runner slots and hand back their merged run [C7].
 *
 * @param {string} root
 * @param {string} command - The whole command the receipt records.
 * @param {object} options - runProfiledShellAsync's options.
 * @param {(plan: object) => Promise<object>} execute - Runs the plan and returns its one run.
 */
export async function runProfiledShardsAsync(root, command, options, execute) {
  const execution = profiledExecution(root, command, options);
  try {
    const { value: plan } = execution.next();
    return execution.next(await execute(plan)).value;
  } finally { execution.return(); }
}

/** Keep raw TAP intact while resolving its measured filenames against the checkout that ran them. */
function runTiming(run, command, root) {
  const shards = landingShardProfile(run.output);
  const profile = { ...timingFromOutput(run.output, timingRunner(command)), ...(shards ? { landingShards: shards } : {}) };
  if (!run.executionRunner) {
    // Node names a crashed file by the absolute path it ran; a local profile names files from the repository root.
    const bases = [root, (() => { try { return realpathSync(root); } catch { return root; } })()];
    const repoPath = path => {
      if (typeof path !== 'string' || !isAbsolute(path)) return path;
      const inside = bases.map(base => relative(base, path)).find(suffix => suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
      return inside ?? path;
    };
    return { ...profile, files: (profile.files ?? []).map(file => ({ ...file, path: repoPath(file.path) })),
      tests: (profile.tests ?? []).map(test => ({ ...test, file: repoPath(test.file) })) };
  }
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
  const sourcePreparation = sourcePreparationFields(run.sourcePreparation);
  return { ...profile, executionRunner: run.executionRunner, executionSource: run.executionSource,
    ...(run.executionPhases ? { executionPhases: run.executionPhases } : {}),
    ...(sourcePreparation ? { sourcePreparation } : {}),
    files: (profile.files ?? []).map(file => ({ ...file, path: localPath(file.path) })),
    tests: (profile.tests ?? []).map(test => ({ ...test, file: localPath(test.file) })) };
}

/** Validate landing membership before admission; generic SSH capacity cannot stand in for a constrained host. */
export async function withLandingGateSlot(root, action, options = {}) {
  const executionServices = requireGateExecutionServices(options.executionServices);
  const constrained = executionServices.landing.constrainedLandingHost(root);
  if (constrained && requiredExecutorOf(options.requiredExecutor)?.kind === 'ssh') throw new Refused('LAND_ENVIRONMENT', 'the required SSH executor conflicts with this board’s constrained local landing policy');
  return withGateSlot(root, action, { ...options, executionServices, landing: true, ...(constrained ? { remote: false } : {}) });
}

/**
 * Where a landing gate's own command runs. A sharded landing runs its controller here, so run-tests fans one shard out
 * to each runner; placed whole on a runner, it was already inside a runner slot and never sharded, so every landing ran
 * its selection serially on one runner (about 30 minutes) [C7,#3158].
 * A runners-only machine (the coordinator) keeps the runner placement: its controller is a apps/cli/src/io/run/tests.js process,
 * which the coordinator test guard refuses at once, so every landing gate there went red in 3 s with no named
 * failure and every landing ended LAND_DIAGNOSTIC from 06:57Z on 9 Nov (#3899). There the placement is the machine's
 * runner-only admission, so the gate, or a local-trunk guard, runs on a runner like a submit gate does.
 *
 * @param {string} root
 * @param {{ required?: unknown, admission?: ReturnType<typeof gateRunnerAdmission> }} [facts] - admission defaults to this machine's.
 * @returns {{ remote?: boolean, runnerOnly?: boolean, runnerWaitMs?: number, runnerDeadlineAt?: number }}
 */
export function landingControllerPlacement(root, { required, admission = gateRunnerAdmission() } = {}) {
  if (admission?.runnerOnly === true) return admission;
  // Only a gate's own controller calls this; its shards keep their runner placement and read runners-only themselves
  // (runLandingShards' own gateRunnerAdmission).
  if (required) return {};
  // Dropping runners-only drops its captured wait and deadline too, which the slot refuses without it.
  return landingShardCount(root) > 1 ? { remote: false, runnerOnly: false, runnerWaitMs: undefined, runnerDeadlineAt: undefined } : {};
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
 * @param {{ trustStamp?: boolean, onWait?: (state: object) => void, landing?: boolean, runnerOnly?: boolean, collectAll?: boolean, auditBatchId?: string, agent?: string, item?: string|number }} [options]
 * @returns {Promise<{ isGreen: boolean, isCached: boolean, output: string, seconds: number, log: string, profile?: object, profilePath?: string }>}
 */
export async function runGate(root, config, { trustStamp = true, onWait, landing = false, runnerOnly = false, collectAll = false, auditBatchId, auditFiles, auditCoverage = false, releaseRequest, agent, item = '', stages = false, waivers = [], quarantines = [], proofContext, onFailure, executionServices, shard = null } = {}) {
  const runnerAdmission = gateRunnerAdmission();
  const releaseStartedAt = releaseRequest ? new Date().toISOString() : null;
  if (releaseRequest && (!landing || !collectAll || trustStamp || auditBatchId !== undefined
    || releaseRequest.version !== 1 || !/^[a-f0-9-]{36}$/u.test(releaseRequest.id ?? '')
    || !Array.isArray(releaseRequest.executors) || releaseRequest.executors.length < 1)) {
    throw new Refused('GATE_RUN_EVIDENCE', 'a release needs fresh full collection and its distinct native executor request');
  }
  if (releaseRequest && (runnerOnly || runnerAdmission.runnerOnly === true)) {
    throw new Refused('RUNNER_SOURCE', 'runner-only landing refuses the required local release executor; run this captured release on a machine allowing local tests');
  }
  if (auditBatchId !== undefined && (!landing || !collectAll || !/^[a-zA-Z0-9_-]{1,80}$/u.test(auditBatchId))) {
    throw new Refused('GATE_RUN_EVIDENCE', 'a main audit needs its exact landing batch and full collection mode');
  }
  if (auditFiles !== undefined) {
    if (!auditBatchId || !Array.isArray(auditFiles) || !auditFiles.length
      || auditFiles.some(file => !committedTest(root, headCommit(root), file))) throw new Refused('GATE_RUN_EVIDENCE', 'an incremental audit needs committed test files');
    const gate = valueGateCommand(root, config.gate, [...new Set(auditFiles)].sort());
    if (!gate) throw new Refused('GATE_RUN_EVIDENCE', 'this gate cannot safely select incremental audit files');
    config = { ...config, gate, [VALUE_GATE]: true };
  }
  if (auditCoverage && !auditBatchId) throw new Refused('GATE_RUN_EVIDENCE', 'coverage collection belongs to a native main audit');
  if (!config.gate.trim()) {
    throw missingGate(root);
  }
  if (trustStamp && !config[VALUE_GATE] && isStampedGreen(root)) return { isGreen: true, isCached: true, output: '', seconds: 0, log: '' };
  const slotOptions = {
    executionServices, landing, ...runnerAdmission, runnerOnly: runnerOnly || runnerAdmission.runnerOnly === true,
    browser: true, gui: projectNeedsGui(root), agent, item, kind: landing ? 'landing' : 'gate', onWait,
    ...(releaseRequest ? { requiredExecutor: { kind: 'local' } } : {}),
    ...(landing && !runnerOnly ? landingControllerPlacement(root, { required: releaseRequest }) : {}),
  };
  return await (landing ? withLandingGateSlot : withGateSlot)(root, async (lease) => {
    if (landing) lease.timingOperation = 'landing-gate';
    lease.testTiers = Boolean(config[VALUE_GATE]);
    lease.quarantines = quarantines;
    if (quarantines.length && proofContext) lease.proof = proofContext;
    pinRunMain(lease, onFailure);
    const options = { waitMs: lease.waitMs, gateLease: lease, landing, collectAll, auditBatchId, auditFiles, auditCoverage, releaseRequest, releaseStartedAt, stages: stages || quarantines.length > 0, waivers, kind: releaseRequest ? 'release' : landing ? 'land' : 'gate' };
    // A landing rerun on a runner lease fans its files out like a submit proof; the receipt and records stay the gate's [C7].
    const run = landing && lease.runner && !releaseRequest && auditBatchId === undefined && landingShardable(config.gate, shard)
      ? await fullGateRunWith(root, config, trustStamp, options, plan => landingShardExecution(root, shard, slotOptions, { say: shard.say, settings: loadMachineSettings })(plan))
      // A landing awaits its run: a synchronous runner call blocked the lander's event loop, its landing lease heartbeat
      // stopped, and a 1-file rerun of 333 s lost the lease and ended in LAND_LEASE_LOST (9 Nov) [C7].
      : landing ? await fullGateRunAsync(root, config, trustStamp, options) : fullGateRun(root, config, trustStamp, options);
    if (!run.isGreen && !run.timedOut && onFailure) await onFailure(run, { root, command: config.gate, lease });
    await recordRun(onFailure, run);
    return run;
  }, slotOptions);
}

/**
 * Run the accepted exact-file main comparison and seal only its own observed execution duration. A `source` of
 * `{head, tree}` runs that exact commit on the admitted runner from this repository's objects, so `root` may be any
 * checkout of the repository and its HEAD is never read [C7,#3323].
 */
export async function runMainComparison(root, path, { detailed = false, gateLease, waitMs = 0, signatureCapture, source } = {}) {
  if (gateLease && signatureCapture) gateLease.signatureCapture = signatureCapture;
  // A pinned source is main's exact commit, sent to a runner from the object store; only a runner can run it [C7,#3323].
  if (source && (!gateLease?.runner || gateLease.source?.pinned !== true || gateLease.source.commit !== source.head || gateLease.source.tree !== source.tree)) {
    throw new Refused('RUNNER_SOURCE', 'a pinned main comparison needs its runner slot admitted for the same commit; retry the comparison');
  }
  const pinnedSource = source ? { head: source.head, tree: source.tree } : undefined;
  const before = pinnedSource ?? timingSourceForReceipt(root);
  const policy = before && policyAt(root, before.head);
  if (!policy || typeof policy.config.affectedTests !== 'string' || !policy.config.affectedTests.trim()
    || typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Refused('NO_POLICY', 'an exact main comparison needs clean source and its accepted focused test command');
  }
  const word = "'" + ('./' + path).replaceAll("'", "'\\''") + "'";
  const command = `PULLBOARD_TEST_REUSE=0 ${policy.config.affectedTests.trimEnd()} ${word}`;
  const started = performance.now();
  // Always awaited: a landing's failure diagnostics run this, and a blocking run stopped the landing lease's heartbeat [C7].
  const run = detailed ? await runProfiledShellAsync(root, command, { gateLease, waitMs, stages: true, pinnedSource })
    : await runProfiledShellAsync(root, command, { gateLease, waitMs, pinnedSource });
  const compareMs = performance.now() - started;
  const after = pinnedSource ?? timingSourceForReceipt(root);
  const receiptId = sameTimingSource(before, after) && !run.sandboxBlocked
    ? leaveRunReceipt(root, { gate: command }, run, { before: before.tree, kind: 'main-red',
      comparison: { path, source: before, compareMs, pinned: Boolean(pinnedSource) }, gateLease, receiptAt: new Date().toISOString() }) : null;
  return { ...run, ...(receiptId ? { receiptId } : {}) };
}

/** Hand a run's receipt to its observer, which records it on the board; recording never changes the run's verdict [C7,D1]. */
export async function recordRun(observer, run) {
  const id = run.proofReceiptId ?? run.receiptId;
  if (!id || typeof observer?.recordRun !== 'function') return;
  try { await observer.recordRun(id); } catch { /* A board that cannot take the record leaves the gate result as it was. */ }
}

/**
 * Leave the receipt of one real run of the accepted gate: its tree, the command's digest, its result, the committed
 * tests that failed and the host load, taken from the process this module just ran. It is private to this module on
 * purpose: no caller can hand it a result, so a receipt always describes an execution [C7,D1]. A run of any other
 * command, or one whose checkout was dirty or moved while it ran, proves nothing about a tree and leaves no receipt.
 *
 * @returns {string | null} the receipt id
 */
function leaveRunReceipt(root, config, run, { before, kind, auditBatchId, auditFiles, releaseRequest, receiptAt, comparison, gateLease }) {
  try {
    // A pinned comparison's tree is the one the runner signed for, so its receipt binds that, not this checkout [C7,#3323].
    const pinned = kind === 'main-red' && comparison?.pinned === true;
    if (pinned && (run.executionSource?.commit !== comparison.source.head || run.executionSource?.tree !== before)) return null;
    if (before === null || !pinned && committedTree(root) !== before || run.executionSourceUnchanged === false) return null;
    const head = kind === 'main-red' ? comparison?.source.head : headCommit(root);
    const policy = kind === 'main-red' ? policyAt(root, head)
      : auditBatchId === undefined && !releaseRequest ? mainPolicy(root) : policyAt(root, head);
    const store = receiptStore(root);
    const focusedWord = comparison && "'" + ('./' + comparison.path).replaceAll("'", "'\\''") + "'";
    const expected = kind === 'main-red' ? comparison && `PULLBOARD_TEST_REUSE=0 ${policy.config.affectedTests.trimEnd()} ${focusedWord}`
      : kind === 'suite' ? 'node apps/cli/src/io/run/tests.js --all'
      : auditFiles === undefined ? policy.config.gate : valueGateCommand(root, policy.config.gate, [...new Set(auditFiles)].sort());
    if (expected !== config.gate || !head || !store
      || kind === 'main-red' && !pinned && !sameTimingSource(comparison?.source, timingSourceForReceipt(root))) return null;
    const failures = new Map();
    for (const row of rawRunGreen(run) ? [] : tapTests(run.output ?? '', run.executionRoot ?? root)) {
      if (row.passed || row.skip || row.type === 'suite' || ['subtestsFailed', 'cancelledByParent', 'testAborted'].includes(row.failureType)) continue;
      if (row.file && committedTest(root, head, row.file)) failures.set(JSON.stringify([row.file, row.name]), { file: row.file, name: row.name });
    }
    const local = { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) };
    const report = run.collectionReport;
    const plan = report?.plannedFiles ?? [], completed = report?.completedFiles ?? [];
    const digest = files => createHash('sha256').update(JSON.stringify([...files].sort())).digest('hex');
    const collection = auditBatchId === undefined && !releaseRequest ? null : { version: 1, mode: 'all', batchId: releaseRequest?.id ?? auditBatchId,
      full: report?.full === true, files: [...plan].sort(),
      complete: run.collectAllComplete === true, plannedFiles: plan.length, completedFiles: completed.length,
      planDigest: digest(plan), completedDigest: digest(completed) };
    const rawFailures = run.quarantineFailures ?? [...failures.values()];
    let signed = null;
    try { signed = observedFailureSignatures({ version: gateLease?.signatureCapture?.version,
      failures: !rawRunGreen(run) && run.stages ? gateLease?.signatureCapture?.derive(run, root) : null }, rawFailures); }
    catch { /* Optional diagnostics cannot erase the raw native receipt. */ }
    const receipt = receiptFields({ version: 1, id: randomUUID(), kind, tree: before, head, main: policy.commit, command: createHash('sha256').update(config.gate).digest('hex'),
      ...(signed ? { failureSignatures: signed } : {}),
      green: rawRunGreen(run), failures: rawFailures, load: Array.isArray(run.executionLoad?.average) ? run.executionLoad : local, at: receiptAt, environment: run.environment ?? null, ...(collection ? { collection } : {}),
      ...(run.testOutcomes ? { testOutcomes: run.testOutcomes } : {}),
      ...(run.blockingVerdict ? { blockingVerdict: run.blockingVerdict } : {}),
      full: kind === 'main-red' ? false : run.suiteTiming?.full ?? null,
      timing: kind === 'main-red' ? { version: 1, node: run.suiteTiming?.node ?? run.environment?.node ?? null,
        wallMs: comparison.compareMs, selectionMs: null, setupMs: null, shards: null, compareMs: comparison.compareMs }
        : observedRunTiming(run, run.suiteTiming),
      ...(releaseRequest ? { participationDigest: releaseParticipationDigest(run.releaseParticipation) } : {}) });
    if (!receipt) return null;
    mkdirSync(store, { recursive: true, mode: 0o700 });
    writeFileSync(join(store, `${receipt.id}.json`), receiptBody(receipt), { flag: 'wx', mode: 0o600 });
    if (!run.proofReceiptId) retainTestValueTimings(store, receipt.id, testValueProfile(root, run));
    return receipt.id;
  } catch { return null; }
}

/** Run a full gate while its caller owns the queue lease; only a full run may stamp its tree. */
function* fullGateExecution(root, config, trustStamp = false, { waitMs = 0, log = gitPath(root, LOG), gateLease, landing = false, collectAll = false, auditBatchId, auditFiles, auditCoverage = false, releaseRequest, releaseStartedAt, stages = false, waivers = [], kind = 'gate', signal } = {}) {
  if (trustStamp && !config[VALUE_GATE] && isStampedGreen(root)) return { isGreen: true, isCached: true, output: '', seconds: 0, log: '' };
  const before = committedTree(root);
  const run = yield [root, config.gate, { waitMs, pipefail: true, profileFile: `${log}.profile.json`, gateLease, landing, collectAll, releaseRequest, stages, waivers, auditCoverage, timeoutMs: landing ? config.landing?.timeoutMs : undefined, signal }];
  const { isGreen, output, seconds, profile, profilePath } = run;
  writeFileSync(log, output);
  // The environment refusing a run says nothing about the gate, so only a real result is recorded (U41).
  if (!run.sandboxBlocked && kind !== 'suite') recordGateRun(root, gateRunRecord(root, config, rawRunGreen(run), gateLease));
  const receiptAt = new Date().toISOString();
  if (releaseRequest) run.releaseParticipation = releaseParticipationFields({ ...run.releaseParticipation,
    command: createHash('sha256').update(config.gate).digest('hex'), startedAt: releaseStartedAt, finishedAt: receiptAt });
  const receiptId = run.sandboxBlocked ? null : leaveRunReceipt(root, config, run, { before, kind, auditBatchId, auditFiles, releaseRequest, receiptAt, gateLease });
  refuseSandboxBlocked(run);
  // The release producer validates full collection and every executor before it may stamp this tree.
  if (kind !== 'suite' && !releaseRequest && rawRunGreen(run) && !config[VALUE_GATE] && before !== null && committedTree(root) === before) writeFileSync(gitPath(root, STAMP), `${before}\n`);
  return { isGreen, exitCode: run.exitCode, isCached: false, output, seconds, log, profile, profilePath, receiptId, environment: run.environment ?? null,
    ...(run.blockingVerdict ? { blockingVerdict: run.blockingVerdict, rawIsGreen: run.rawIsGreen, quarantineFailures: run.quarantineFailures } : {}),
    ...(releaseRequest ? { releaseParticipation: run.releaseParticipation ?? null } : {}),
    ...(collectAll ? { collectAllComplete: run.collectAllComplete === true, collectionReport: run.collectionReport ?? null,
      ...(run.cleanupVerified === undefined ? {} : { cleanupVerified: run.cleanupVerified }) } : {}),
    ...(run.cleanupUnverified ? { cleanupUnverified: true } : {}),
    ...(run.proofReceiptId ? { proofReceiptId: run.proofReceiptId } : {}), ...(run.timedOut ? { timedOut: true } : {}), ...(run.executionRoot ? { executionRoot: run.executionRoot } : {}),
    // A remote run's host load and pinned main reach the flake diagnostics with it (#925).
    ...(run.executionRunner ? { executionRunner: run.executionRunner, executionMain: run.executionMain ?? null, executionLoad: run.executionLoad ?? null } : {}), ...(stages ? { stages: run.stages } : {}) };
}

/** Keep full-gate records and stamps identical for synchronous callers. */
export function fullGateRun(root, config, trustStamp = false, options) {
  const execution = fullGateExecution(root, config, trustStamp, options);
  try {
    const step = execution.next();
    return step.done ? step.value : execution.next(runProfiledShell(...step.value)).value;
  } finally { execution.return(); }
}

/**
 * Run a full gate whose one command the caller executes, as shards or whole: the profile, run record, receipt and
 * stamp rules are fullGateRun's own, so a sharded landing gate leaves exactly the records an unsharded one does [C7].
 *
 * @param {(execution: object) => Promise<object>} execute - Runs the profiled plan and returns its one run.
 */
export async function fullGateRunWith(root, config, trustStamp, options, execute) {
  const execution = fullGateExecution(root, config, trustStamp, options);
  try {
    const step = execution.next();
    return step.done ? step.value : execution.next(await runProfiledShardsAsync(...step.value, execute)).value;
  } finally { execution.return(); }
}

/** Await a full gate without serializing another check behind its shell process. */
export async function fullGateRunAsync(root, config, trustStamp = false, options) {
  const execution = fullGateExecution(root, config, trustStamp, options);
  try {
    const step = execution.next();
    return step.done ? step.value : execution.next(await runProfiledShellAsync(...step.value)).value;
  } finally { execution.return(); }
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

