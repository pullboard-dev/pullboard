/** Concern-specific gate stage; public callers keep the gate facade. */
import {
  TIMING_RUN_ID_ENV,
  suiteTimingFromOutput,
  observedRunTiming,
  timingSource as timingSourceForReceipt,
  sameTimingSource,
} from './run-timing.js';
import {
  settleReceipt,
  withGateSlot,
} from './gate-slot.js';
import {
  policyAt,
} from './trusted-policy-read.js';
import {
  COLLECTION_ID_ENV,
  parseCollectionReports,
} from './landing-collection-report.js';
import {
  retainTestValueTimings,
} from './test-value-timing.js';
import {
  VALUE_GATE,
  valueGateCommand,
} from './test-placement.js';
import {
  projectNeedsGui,
} from './gui-admission.js';
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
} from 'node:os';
import {
  fileURLToPath,
} from 'node:url';
import {
  captureTestRuntimes,
  executionEnvironment,
  testRuntimeEnvironment,
} from './execution-environment.js';
import {
  constrainedLandingHost,
} from './landing-host.js';
import {
  gitChildEnv,
  gitPath,
  headCommit,
  headTree,
  invalidateGitFacts,
  isClean,
  tryGit,
  untracked,
} from './git.js';
import {
  recordGateRun,
} from './gate-control.js';
import {
  receiptBody,
  receiptFields,
  receiptStore,
} from './gate-run-receipt.js';
import {
  committedTest,
  tapTests,
} from './tap-tests.js';
import {
  checkAtCommit,
  frozenCheck,
  mainPolicy,
} from './trusted-policy.js';
import {
  proofCounts,
} from './proof-provenance.js';
import {
  logLines,
} from './timing.js';
import {
  secretsIn,
} from './hooks.js';
import {
  Refused,
} from './refused.js';
import {
  missingGate,
} from './gate-config.js';
import {
  GATE_SLOT_HELD_ENV,
  gateSlotEnvironment,
  requiredExecutorOf,
} from './resources.js';
import {
  timingFromOutput,
  timingRunner,
} from './timing.js';
import {
  landingShardProfile,
  RELEASE_EXECUTORS_ENV,
  releaseParticipation,
} from './landing-shards.js';
import {
  releaseParticipationFields,
  releaseParticipationDigest,
} from './release-gate-receipt.js';
import {
  runShell,
} from './shell-run.js';
import {
  writeTimingProfile,
} from './gate-output.js';
import {
  runOnRunner,
  runOnRunnerAsync,
} from './runners.js';
import {
  sandboxBlockedOperation,
} from './sandbox-denial.js';
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
 * @param {{ waitMs?: number, artifactDirectory?: string, artifactPrefix?: string, persistLog?: boolean, profileFile?: string, pipefail?: boolean, gateSlotHeld?: boolean, gateLease?: object, landing?: boolean, collectAll?: boolean, stages?: boolean, timeoutMs?: number, waivers?: Array<{ kind: string, test: string }> }} [options]
 */
export function runProfiledShell(root, command, { waitMs = 0, artifactDirectory, artifactPrefix = 'pullboard-gate', persistLog = false, profileFile, pipefail = false, gateSlotHeld = false, gateLease, landing = false, collectAll = false, releaseRequest, stages = false, waivers = [], timeoutMs, auditCoverage = false } = {}) {
  const proofSource = gateLease?.proof ? proofSourceAt(root) : null;
  const directory = artifactDirectory ?? dirname(gitPath(root, LOG));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const profilePath = profileFile ?? join(directory, `${artifactPrefix}-${id}.profile.json`);
  const logPath = persistLog ? join(directory, `${artifactPrefix}-${id}.log`) : null;
  const started = Date.now();
  const collectionId = landing && collectAll ? randomUUID() : null;
  const inherited = {
    [TIMING_RUN_ID_ENV]: id,
    ...(auditCoverage ? { PULLBOARD_AUDIT_COVERAGE_REPORTER: fileURLToPath(new URL('./audit-coverage-reporter.js', import.meta.url)), PULLBOARD_TEST_REUSE: '0' } : {}),
    ...(gateLease && !gateLease.runner ? gateSlotEnvironment(gateLease) : gateSlotHeld ? { [GATE_SLOT_HELD_ENV]: '1' } : {}),
    [LANDING_RUN_ENV]: landing ? '1' : '0',
    [LANDING_COLLECT_ALL_ENV]: landing && collectAll ? '1' : '0',
    [COLLECTION_ID_ENV]: collectionId ?? '',
    [RELEASE_EXECUTORS_ENV]: releaseRequest ? JSON.stringify(releaseRequest) : '',
    [LANDING_WAIVERS_ENV]: landing ? JSON.stringify(waivers) : '[]',
    // A reused test result names the stage that ran it (#1045).
    PULLBOARD_TEST_STAGE: gateLease?.receiptKind ?? (landing ? 'land' : 'gate'),
  };
  // The registered worker returns the same complete stage/component accounting as a local run.
  gateLease?.tracker?.mark('runAt');
  const remoteCommand = landing && collectAll ? `(export ${LANDING_COLLECT_ALL_ENV}=1 ${COLLECTION_ID_ENV}=${collectionId}\n${command}\n)` : command;
  const run = gateLease?.runner ? { ...runOnRunner(root, remoteCommand, { runner: gateLease.runner, source: gateLease.source, runnerWaitDeadline: gateLease.runnerWaitDeadline,
    browser: gateLease.browser, pipefail, stages, waivers: landing ? waivers : [], metadata: { ...(gateLease.runMetadata ?? {}), landing, auditCoverage,
      testStage: inherited.PULLBOARD_TEST_STAGE, timingRunId: id, ...(timeoutMs ? { timeoutMs } : {}) } }) }
    : runShell(root, command, { pipefail, env: inherited, stages, timeoutMs, captureRuntimes: Boolean(gateLease) });
  gateLease?.tracker?.mark('ranAt');
  if (gateLease) {
    gateLease.environment = run.environment ?? null;
    gateLease.gui = run.executionCapabilities?.gui ?? null;
    gateLease.executionAdmission = run.executionAdmission ?? null;
    gateLease.executionPhases = run.executionPhases ?? null;
  }
  const sandboxBlocked = run.isGreen ? null : run.sandboxBlocked ?? (run.executionRunner
    // The controller cannot realpath remote files; retain the network denial signal without treating remote paths as local paths.
    ? sandboxBlockedOperation(root, run.output, { includeFilePaths: false })
    : sandboxBlockedOperation(root, run.output));
  const profiledRun = { ...run, sandboxBlocked };
  if (logPath) writeFileSync(logPath, safeLog(run.output), { mode: 0o600 });
  const profile = writeTimingProfile(profilePath, {
    ...runTiming(profiledRun, command, root),
    waitMs: Math.max(0, Math.round(waitMs)), wallMs: Math.max(0, Date.now() - started), receipt: settleReceipt(gateLease),
  });
  const collectionReport = collectionId ? parseCollectionReports(run.output, { id: collectionId, scope: 'suite', requireComplete: false }) : null;
  const result = { ...profiledRun, profile, profilePath, logPath,
    suiteTiming: suiteTimingFromOutput(run.output, id, run.executionSource
      ? { head: run.executionSource.commit, tree: run.executionSource.tree } : timingSourceForReceipt(root)),
    ...(releaseRequest ? { releaseParticipation: releaseParticipation(run.output, releaseRequest.id) } : {}),
    ...(collectAll ? { collectAllComplete: collectionReport?.complete === true, collectionReport,
      cleanupVerified: collectionReport?.cleanupVerified === true } : {}) };
  const proofReceiptId = gateLease?.proof && leaveProofReceipt(root, command, result, proofSource, gateLease.proof, gateLease);
  return { ...result, ...(proofReceiptId ? { proofReceiptId } : {}) };
}

/** Capture source identifiers before execution; a dirty tree remains explicitly unproven. */
function proofSourceAt(root, commit = null) {
  invalidateGitFacts(); // The child may have changed Git facts outside this command context.
  const head = commit ?? headCommit(root);
  const tree = head ? tryGit(root, ['rev-parse', '--verify', `${head}^{tree}`], { env: gitChildEnv(root) }) : null;
  const clean = commit !== null || committedTree(root) !== null;
  return { head: clean ? head : null, tree: clean && tree?.status === 0 ? tree.stdout : null, clean };
}

/** Retain explicit executed TAP outcomes; skipped, aggregate and aborted cases prove no named result. */
function testValueProfile(root, run) {
  try {
    return { ...run.profile, tests: tapTests(run.output ?? '', run.executionRoot ?? root).filter(row =>
      !row.skip && row.type !== 'suite'
      && !['subtestsFailed', 'cancelledByParent', 'testAborted'].includes(row.failureType)) };
  } catch { return null; }
}

/** The private gate writer records process results, never provenance supplied by a CLI argument. */
function leaveProofReceipt(root, command, run, before, context, lease) {
  try {
    if (!before || run.sandboxBlocked || run.exitCode === undefined) return null;
    const store = receiptStore(root);
    if (!store) return null;
    const after = context.commit ? before : proofSourceAt(root);
    const source = run.executionSource ?? run.profile?.executionSource;
    const sourceClean = before.clean && after.clean && before.head === after.head && before.tree === after.tree
      && run.executionSourceUnchanged !== false && (!source || source.commit === before.head && source.tree === before.tree)
      && (!lease?.runner || Boolean(source));
    const testRuntimes = run.testRuntimes ?? run.profile?.testRuntimes ?? null;
    const environment = testRuntimeEnvironment(testRuntimes);
    const remote = run.executionRunner ?? run.profile?.executionRunner;
    const localLoad = { average: loadavg(), cpus: availableParallelism(), freeMB: Math.floor(freemem() / 1048576) };
    let main = null;
    try { main = mainPolicy(root).commit; } catch { /* An unavailable policy remains unknown in this execution record. */ }
    const receipt = receiptFields({ version: 2, id: randomUUID(), kind: context.kind,
      tree: before.tree, head: before.head, main, command: createHash('sha256').update(command).digest('hex'),
      green: run.isGreen ?? run.state === 'pass', failures: (run.isGreen ?? run.state === 'pass') ? []
        : tapTests(run.output ?? '', run.executionRoot ?? root).filter(row => !row.passed && !row.skip && row.file
          && row.type !== 'suite' && !['subtestsFailed','cancelledByParent','testAborted'].includes(row.failureType))
          .slice(0, 500).map(({ file, name }) => ({ file, name })),
      load: run.executionLoad ?? (remote || lease?.runner ? null : localLoad), at: new Date().toISOString(),
      proof: { item: context.item, frozenDigest: context.frozenDigest ?? null, seat: context.seat,
        environment, testRuntimes, runner: remote ?? (lease?.runner ? null
          : run.profile?.receipt?.runner?.id ?? lease?.receipt?.runner?.id ?? lease?.localDescriptor?.id ?? null), exitCode: run.exitCode,
        counts: run.proofCounts ?? proofCounts(run.outputPath ? logLines(run.outputPath) : run.output ?? ''),
        durationMs: Math.max(0, Math.round(run.remoteWallMs ?? run.profile?.wallMs ?? run.seconds * 1000)), sourceClean,
        ...(context.submitAdmission ? { submitAdmission: context.submitAdmission } : {}) } });
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
export function runFrozenProof(root, item, { gateLease, waitMs = 0 } = {}) {
  const context = { item: item.item_id, frozenDigest: item.item_frozen_digest ?? null,
    seat: gateLease?.proof?.seat, kind: 'verdict', commit: item.item_commit };
  const before = proofSourceAt(root, item.item_commit);
  const result = checkAtCommit(root, item, { gateLease, waitMs });
  const id = result.executed ? leaveProofReceipt(root, frozenCheck(item), result, before, context, gateLease) : null;
  return { ...result, ...(id ? { proofReceiptId: id } : {}) };
}

/** Run an independent focused comparison without blocking other holders of the machine pool.
 * @param {string} root
 * @param {string} command
 * @param {{ waitMs?: number, gateSlotHeld?: boolean, gateLease?: object, landing?: boolean }} [options]
 * @returns {Promise<object>} The unchanged shell verdict and its private timing profile.
 */
export async function runProfiledShellAsync(root, command, { waitMs = 0, gateSlotHeld = false, gateLease, landing = false } = {}) {
  const started = Date.now();
  gateLease?.tracker?.mark('runAt');
  if (gateLease?.runner) {
    const run = await runOnRunnerAsync(root, command, { runner: gateLease.runner, source: gateLease.source, runnerWaitDeadline: gateLease.runnerWaitDeadline,
      browser: gateLease.browser, metadata: { ...(gateLease.runMetadata ?? {}), landing,
        testStage: gateLease.receiptKind ?? (landing ? 'land' : 'gate') } });
    gateLease.environment = run.environment ?? null;
    gateLease.gui = run.executionCapabilities?.gui ?? null;
    gateLease.executionAdmission = run.executionAdmission ?? null;
    gateLease.executionPhases = run.executionPhases ?? null;
    gateLease.tracker?.mark('ranAt');
    const wallMs = Math.max(0, Date.now() - started);
    const profilePath = join(dirname(gitPath(root, LOG)), `pullboard-gate-${randomUUID()}.profile.json`);
    const sandboxBlocked = run.isGreen ? null : run.sandboxBlocked
      ?? sandboxBlockedOperation(root, run.output, { includeFilePaths: false });
    const profile = writeTimingProfile(profilePath, { ...runTiming(run, command, root), waitMs, wallMs, receipt: settleReceipt(gateLease) });
    return { ...run, sandboxBlocked, seconds: Math.round(wallMs / 1000), profile, profilePath, logPath: null };
  }
  const inherited = {
    ...(gateLease ? gateSlotEnvironment(gateLease) : gateSlotHeld ? { [GATE_SLOT_HELD_ENV]: '1' } : {}),
    [LANDING_RUN_ENV]: landing ? '1' : '0',
    PULLBOARD_TEST_STAGE: gateLease?.receiptKind ?? (landing ? 'land' : 'gate'),
  };
  const runtimes = captureTestRuntimes({ ...gitChildEnv(root), ...inherited });
  const env = runtimes.env;
  const environment = executionEnvironment();
  const child = spawn(`(\n${command}\n) 2>&1`, { cwd: root, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  let bytes = 0;
  let overflow = false;
  let failure = null;
  /** Retain merged shell output within the same one-GiB limit as the synchronous gate runner. */
  const capture = part => {
    bytes += Buffer.byteLength(part);
    if (bytes > 2 ** 30) { overflow = true; child.kill(); }
    else chunks.push(part);
  };
  child.stdout.setEncoding('utf8').on('data', capture);
  child.stderr.setEncoding('utf8').on('data', capture);
  child.once('error', error => { failure = error; });
  const status = await new Promise(resolveClose => child.once('close', resolveClose));
  const testRuntimes = runtimes.finish();
  gateLease?.tracker?.mark('ranAt');
  if (gateLease) gateLease.environment = environment;
  invalidateGitFacts();
  const output = chunks.join('') + (overflow ? '\nFocused comparison output exceeded one GiB.\n' : '')
    + (failure ? `\n${failure.message}\n` : '');
  const wallMs = Math.max(0, Date.now() - started);
  const profilePath = join(dirname(gitPath(root, LOG)), `pullboard-gate-${randomUUID()}.profile.json`);
  const profile = writeTimingProfile(profilePath, { ...timingFromOutput(output, timingRunner(command)),
    waitMs: Math.max(0, Math.round(waitMs)), wallMs, receipt: settleReceipt(gateLease) });
  return { isGreen: status === 0 && !overflow && !failure, environment, testRuntimes, sandboxBlocked: status === 0 ? null : sandboxBlockedOperation(root, output), output, seconds: Math.round(wallMs / 1000), profile, profilePath, logPath: null };
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
    return { ...profile, files: (profile.files ?? []).map(file => ({ ...file, path: repoPath(file.path) })) };
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
  return { ...profile, executionRunner: run.executionRunner, executionSource: run.executionSource,
    ...(run.executionPhases ? { executionPhases: run.executionPhases } : {}),
    files: (profile.files ?? []).map(file => ({ ...file, path: localPath(file.path) })),
    tests: (profile.tests ?? []).map(test => ({ ...test, file: localPath(test.file) })) };
}

/** Validate landing membership before admission; generic SSH capacity cannot stand in for a constrained host. */
export async function withLandingGateSlot(root, action, options = {}) {
  const constrained = constrainedLandingHost(root);
  if (constrained && requiredExecutorOf(options.requiredExecutor)?.kind === 'ssh') throw new Refused('LAND_ENVIRONMENT', 'the required SSH executor conflicts with this board’s constrained local landing policy');
  return withGateSlot(root, action, { ...options, landing: true, ...(constrained ? { remote: false } : {}) });
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
 * @param {{ trustStamp?: boolean, onWait?: (state: object) => void, landing?: boolean, collectAll?: boolean, auditBatchId?: string, agent?: string, item?: string|number }} [options]
 * @returns {Promise<{ isGreen: boolean, isCached: boolean, output: string, seconds: number, log: string, profile?: object, profilePath?: string }>}
 */
export async function runGate(root, config, { trustStamp = true, onWait, landing = false, collectAll = false, auditBatchId, auditFiles, auditCoverage = false, releaseRequest, agent, item = '', stages = false, waivers = [], onFailure } = {}) {
  const releaseStartedAt = releaseRequest ? new Date().toISOString() : null;
  if (releaseRequest && (!landing || !collectAll || trustStamp || auditBatchId !== undefined
    || releaseRequest.version !== 1 || !/^[a-f0-9-]{36}$/u.test(releaseRequest.id ?? '')
    || !Array.isArray(releaseRequest.executors) || releaseRequest.executors.length < 1)) {
    throw new Refused('GATE_RUN_EVIDENCE', 'a release needs fresh full collection and its distinct native executor request');
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
  return await (landing ? withLandingGateSlot : withGateSlot)(root, async (lease) => {
    pinRunMain(lease, onFailure);
    const run = fullGateRun(root, config, trustStamp, { waitMs: lease.waitMs, gateLease: lease, landing, collectAll, auditBatchId, auditFiles, auditCoverage, releaseRequest, releaseStartedAt, stages, waivers, kind: releaseRequest ? 'release' : landing ? 'land' : 'gate' });
    if (!run.isGreen && !run.timedOut && onFailure) await onFailure(run, { root, command: config.gate, lease });
    await recordRun(onFailure, run);
    return run;
  }, {
    landing, browser: true, gui: projectNeedsGui(root), agent, item, kind: landing ? 'landing' : 'gate', onWait,
    ...(releaseRequest ? { requiredExecutor: { kind: 'local' } } : {}),
  });
}

/** Run the accepted exact-file main comparison and seal only its own observed execution duration. */
export async function runMainComparison(root, path, { detailed = false, gateLease, waitMs = 0 } = {}) {
  const before = timingSourceForReceipt(root);
  const policy = before && policyAt(root, before.head);
  if (!policy || typeof policy.config.affectedTests !== 'string' || !policy.config.affectedTests.trim()
    || typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Refused('NO_POLICY', 'an exact main comparison needs clean source and its accepted focused test command');
  }
  const word = "'" + ('./' + path).replaceAll("'", "'\\''") + "'";
  const command = `PULLBOARD_TEST_REUSE=0 ${policy.config.affectedTests.trimEnd()} ${word}`;
  const started = performance.now();
  const run = detailed ? runProfiledShell(root, command, { gateLease, waitMs, stages: true })
    : await runProfiledShellAsync(root, command, { gateLease, waitMs });
  const compareMs = performance.now() - started;
  const after = timingSourceForReceipt(root);
  const receiptId = sameTimingSource(before, after) && !run.sandboxBlocked
    ? leaveRunReceipt(root, { gate: command }, run, { before: before.tree, kind: 'main-red',
      comparison: { path, source: before, compareMs }, receiptAt: new Date().toISOString() }) : null;
  return { ...run, ...(receiptId ? { receiptId } : {}) };
}

/** Hand a run's receipt to its observer, which records it on the board; recording never changes the run's verdict [C7,D1]. */
export async function recordRun(observer, run) {
  if (!run.receiptId || typeof observer?.recordRun !== 'function') return;
  try { await observer.recordRun(run.receiptId); } catch { /* A board that cannot take the record leaves the gate result as it was. */ }
}

/**
 * Leave the receipt of one real run of the accepted gate: its tree, the command's digest, its result, the committed
 * tests that failed and the host load, taken from the process this module just ran. It is private to this module on
 * purpose: no caller can hand it a result, so a receipt always describes an execution [C7,D1]. A run of any other
 * command, or one whose checkout was dirty or moved while it ran, proves nothing about a tree and leaves no receipt.
 *
 * @returns {string | null} the receipt id
 */
function leaveRunReceipt(root, config, run, { before, kind, auditBatchId, auditFiles, releaseRequest, receiptAt, comparison }) {
  try {
    if (before === null || committedTree(root) !== before || run.executionSourceUnchanged === false) return null;
    const head = kind === 'main-red' ? comparison?.source.head : headCommit(root);
    const policy = kind === 'main-red' ? policyAt(root, head)
      : auditBatchId === undefined && !releaseRequest ? mainPolicy(root) : policyAt(root, head);
    const store = receiptStore(root);
    const focusedWord = comparison && "'" + ('./' + comparison.path).replaceAll("'", "'\\''") + "'";
    const expected = kind === 'main-red' ? comparison && `PULLBOARD_TEST_REUSE=0 ${policy.config.affectedTests.trimEnd()} ${focusedWord}`
      : kind === 'suite' ? 'node ./bin/run-tests.js'
      : auditFiles === undefined ? policy.config.gate : valueGateCommand(root, policy.config.gate, [...new Set(auditFiles)].sort());
    if (expected !== config.gate || !head || !store
      || kind === 'main-red' && !sameTimingSource(comparison?.source, timingSourceForReceipt(root))) return null;
    const failures = new Map();
    for (const row of run.isGreen ? [] : tapTests(run.output ?? '', run.executionRoot ?? root)) {
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
    const receipt = receiptFields({ version: 1, id: randomUUID(), kind, tree: before, head, main: policy.commit, command: createHash('sha256').update(config.gate).digest('hex'),
      green: run.isGreen, failures: [...failures.values()], load: Array.isArray(run.executionLoad?.average) ? run.executionLoad : local, at: receiptAt, environment: run.environment ?? null, ...(collection ? { collection } : {}),
      full: kind === 'main-red' ? false : run.suiteTiming?.full ?? null,
      timing: kind === 'main-red' ? { version: 1, node: run.environment?.node ?? null,
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
export function fullGateRun(root, config, trustStamp = false, { waitMs = 0, log = gitPath(root, LOG), gateLease, landing = false, collectAll = false, auditBatchId, auditFiles, auditCoverage = false, releaseRequest, releaseStartedAt, stages = false, waivers = [], kind = 'gate' } = {}) {
  if (trustStamp && !config[VALUE_GATE] && isStampedGreen(root)) return { isGreen: true, isCached: true, output: '', seconds: 0, log: '' };
  const before = committedTree(root);
  const run = runProfiledShell(root, config.gate, { waitMs, pipefail: true, profileFile: `${log}.profile.json`, gateLease, landing, collectAll, releaseRequest, stages, waivers, auditCoverage, timeoutMs: landing ? config.landing?.timeoutMs : undefined });
  const { isGreen, output, seconds, profile, profilePath } = run;
  writeFileSync(log, output);
  // The environment refusing a run says nothing about the gate, so only a real result is recorded (U41).
  if (!run.sandboxBlocked && kind !== 'suite') recordGateRun(root, gateRunRecord(root, config, isGreen, gateLease));
  const receiptAt = new Date().toISOString();
  if (releaseRequest) run.releaseParticipation = releaseParticipationFields({ ...run.releaseParticipation,
    command: createHash('sha256').update(config.gate).digest('hex'), startedAt: releaseStartedAt, finishedAt: receiptAt });
  const receiptId = run.sandboxBlocked ? null : leaveRunReceipt(root, config, run, { before, kind, auditBatchId, auditFiles, releaseRequest, receiptAt });
  refuseSandboxBlocked(run);
  // The release producer validates full collection and every executor before it may stamp this tree.
  if (kind !== 'suite' && !releaseRequest && isGreen && !config[VALUE_GATE] && before !== null && committedTree(root) === before) writeFileSync(gitPath(root, STAMP), `${before}\n`);
  return { isGreen, isCached: false, output, seconds, log, profile, profilePath, receiptId, environment: run.environment ?? null,
    ...(releaseRequest ? { releaseParticipation: run.releaseParticipation ?? null } : {}),
    ...(collectAll ? { collectAllComplete: run.collectAllComplete === true, collectionReport: run.collectionReport ?? null,
      ...(run.cleanupVerified === undefined ? {} : { cleanupVerified: run.cleanupVerified }) } : {}),
    ...(run.cleanupUnverified ? { cleanupUnverified: true } : {}),
    ...(run.proofReceiptId ? { proofReceiptId: run.proofReceiptId } : {}), ...(run.timedOut ? { timedOut: true } : {}), ...(run.executionRoot ? { executionRoot: run.executionRoot } : {}),
    // A remote run's host load and pinned main reach the flake diagnostics with it (#925).
    ...(run.executionRunner ? { executionRunner: run.executionRunner, executionMain: run.executionMain ?? null, executionLoad: run.executionLoad ?? null } : {}), ...(stages ? { stages: run.stages } : {}) };
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

