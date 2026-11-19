import { runnerPolicyRecord } from '../../../../../packages/sandbox/index.js';
import { RUNNER_POLICY_FILE } from '../../../../../packages/sandbox/index.js';
import { TIMING_RUN_ID_ENV } from '../../../../../packages/gate/heavy.js';
import { followRenames } from '../../../../../packages/gate/heavy.js';
/** Controller-owned private checks: immutable clone, runner protocol and retained sanitized evidence [C7,V4]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitSpawnSync } from '../../../../../packages/git/index.js';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { runOnRunnerAsync } from '../../../../../packages/runners/index.js';
import { frozenCheckCeilingMs } from '../../../../../packages/config/index.js';
import {
  privateCheckEnvelope,
  privateGuard,
} from './guard.js';
import { proofCounts } from '../../../../../packages/verify/index.js';
import {
  policyGit,
  trunkRef,
} from '../../../../../packages/sandbox/index.js';
import {
  itemPolicy,
  frozenCheck,
} from '../../../../../packages/sandbox/index.js';
import { mappedCheck } from '../../../../../packages/codemap/index.js';
import { environmentProblem } from '../../../../../packages/config/index.js';
import { scratchFolder } from '../../../../../packages/config/index.js';
import {
  digestOf,
  writeTimingProfile,
} from '../../../../../packages/gate/heavy.js';
import { sandboxBlockedScanner } from '../../../../../packages/sandbox/index.js';
import {
  logLines,
  timingFromLog,
  timingFromOutput,
  timingRunner,
} from '../../../../../packages/gate/heavy.js';
import {
  GATE_SLOT_HELD_ENV,
  gateSlotEnvironment,
} from '../../../../../packages/resources/index.js';
import { cleanGitEnvironment } from '../../../../../packages/git/index.js';
import { secretsIn } from '../../../../../packages/commits/index.js';
import { environmentAdapter } from '../../../../../packages/env/index.js';

/** Copy one authenticated phase without buffering the full command output into controller memory. */
function phaseCopy(raw, phase, path) {
  const input = openSync(raw, 'r');
  const output = openSync(path, 'wx', 0o600);
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  const captures = [];
  let captureBytes = 0;
  try {
    while (offset < phase.length) {
      const count = readSync(input, buffer, 0, Math.min(buffer.length, phase.length - offset), phase.offset + offset);
      if (!count) throw new Error('private-check phase capture is incomplete');
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      let written = 0;
      while (written < count) {
        const progress = writeSync(output, bytes, written, count - written);
        if (!progress) throw new Error('private-check artifact write made no progress');
        written += progress;
      }
      captures.push(Buffer.from(bytes));
      captureBytes += count;
      while (captureBytes > 8 * 1024 * 1024) {
        const excess = captureBytes - 8 * 1024 * 1024;
        if (captures[0].length <= excess) captureBytes -= captures.shift().length;
        else { captures[0] = captures[0].subarray(excess); captureBytes -= excess; }
      }
      offset += count;
    }
    if (hash.digest('hex') !== phase.sha256) throw new Error('private-check phase digest does not match');
    return Buffer.concat(captures, captureBytes).toString('utf8');
  } finally { closeSync(input); closeSync(output); }
}

/** Run only under an actual runner lease, preserving raw evidence even when formatting or transport fails; the pulled run is awaited (#8504). */
export async function runnerPrivateCheck(root, item, command, policy, lease, guard, waitMs, format) {
  const common = policyGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const artifactRoot = join(common, 'pullboard', 'check-output');
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(artifactRoot, 'private-runner-'));
  const ref = trunkRef(root);
  const mode = privateCheckEnvelope({ kind: 'private-check', version: 1, install: policy.config.check.install,
    check: command, timeoutMs: frozenCheckCeilingMs(policy.config), policyCommit: policy.commit,
    trunk: { ref, commit: policyGit(root, ['rev-parse', `${ref}^{commit}`]).trim() }, guard });
  const checkedSource = { commit: item.item_commit, tree: policyGit(root, ['rev-parse', `${item.item_commit}^{tree}`]).trim() };
  const started = Date.now();
  lease.tracker?.mark('runAt');
  const result = await runOnRunnerAsync(root, command, { runner: lease.runner, source: lease.source, runnerWaitDeadline: lease.runnerWaitDeadline, runnerStartupMs: lease.runnerStartupMs, browser: lease.browser, byLaunch: lease.browserByLaunch,
    metadata: { ...lease.runMetadata, ...(lease.testOutcomeRunId ? { timingRunId: lease.testOutcomeRunId } : {}), testStage: lease.receiptKind ?? 'verify' }, checkedSource, privateCheck: mode, rawOutputPath: join(directory, 'raw.log') });
  lease.tracker?.mark('ranAt');
  lease.environment = result.environment ?? null;
  lease.gui = result.executionCapabilities?.gui ?? null;
  lease.executionAdmission = result.executionAdmission ?? null;
  lease.executionPhases = result.executionPhases ?? null;
  let installCapture = '';
  let checkCapture = '';
  let installLogPath = '';
  let checkLogPath = '';
  let captureProblem = false;
  try {
    for (const name of ['install', 'check']) {
      const phase = result.privateCheck.receipt.phases[name];
      if (!phase) continue;
      const path = join(directory, `${name}.log`);
      const capture = phaseCopy(result.rawOutputPath, phase, path);
      if (name === 'install') { installCapture = capture; installLogPath = path; }
      else { checkCapture = capture; checkLogPath = path; }
    }
  } catch { captureProblem = true; }
  const profile = checkLogPath ? timingFromLog(checkLogPath, timingRunner(command)) : { files: [], tests: [] };
  // A recorded check phase ran on the runner, so it earns the same native proof receipt as a local run.
  const checkPhase = result.privateCheck.receipt.phases.check;
  let counts = null;
  try { counts = checkLogPath ? proofCounts(logLines(checkLogPath)) : null; } catch { counts = { passed: null, failed: null, skipped: null }; }
  const formatted = format(captureProblem ? 'unverified' : result.privateCheck.state, captureProblem ? `private-check output could not be authenticated or saved; raw output retained at ${result.rawOutputPath} sha256 ${result.rawOutputSha256}` : result.privateCheck.stage, installCapture, checkCapture,
    { root, item, commandRoot: result.executionRoot, installLogPath, checkLogPath, waitMs,
      timingProfile: { ...profile, wallMs: Date.now() - started, environment: result.environment, testRuntimes: result.testRuntimes,
        executionRunner: result.executionRunner, executionSource: result.executionSource, executionMain: result.executionMain,
        executionLoad: result.executionLoad, executionAdmission: result.executionAdmission, executionPhases: result.executionPhases ?? null,
        privateCheckPolicySha256: mode.sha256, rawOutputPath: result.rawOutputPath, rawOutputSha256: result.rawOutputSha256 },
      environment: result.environment, testRuntimes: result.testRuntimes, executionSourceUnchanged: result.privateCheck.receipt.sourceUnchanged,
      executed: Boolean(checkPhase), exitCode: checkPhase?.code ?? null, proofCounts: counts });
  return { ...formatted, testRuntimes: result.testRuntimes ?? null, sandboxBlocked: result.sandboxBlocked ?? formatted.sandboxBlocked, executionRunner: result.executionRunner, executionSource: result.executionSource,
    executionLoad: result.executionLoad, executionMain: result.executionMain, executionAdmission: result.executionAdmission, executionPhases: result.executionPhases ?? null,
    rawOutputPath: result.rawOutputPath, rawOutputSha256: result.rawOutputSha256,
    guardProblem: result.privateCheck.receipt.guard?.problem ?? '',
    executionNote: `\nprivate check executed on runner ${result.executionRunner} at ${checkedSource.commit}; trusted policy ${policy.commit}; raw output ${result.rawOutputPath} sha256 ${result.rawOutputSha256}` };
}

/** Run the frozen check at the exact submitted commit in a private clone, leaving live worktrees untouched.
 * @param {string} root
 * @param {object} item
 * @param {{ waitMs?: number, gateSlotHeld?: boolean, gateLease?: object, mutate?: (directory: string) => string, guard?: object }} [options] - Queue wait before the private check started;
 *   mutate changes the scratch tree after checkout (a guard revert) and returns a reason when it cannot [C7,V4].
 */
export function checkAtCommit(root, item, options = {}) {
  const frozenCommand = frozenCheck(item);
  if (!frozenCommand) return runCheckAtCommit(root, item, options, []);
  let renames = [];
  try { renames = followRenames(root, mappedCheck(root, frozenCommand, { commit: item.item_commit }), { base: item.item_claim_head, commit: item.item_commit }).followed; } catch { /* the check below reports an unreadable policy */ }
  const ran = runCheckAtCommit(root, item, options, renames);
  // A runner run returns a promise; a local check returns its result at once. Either way the followed renames ride along [C7,#2969].
  return typeof ran?.then === 'function' ? ran.then(result => ({ ...result, renames })) : { ...ran, renames };
}

/** checkAtCommit's work: the same check run, with the renames it already followed passed in. */
function runCheckAtCommit(root, item, { waitMs = 0, gateSlotHeld = false, gateLease, mutate, guard, supplement = '', testTiers } = {}, followedRenames) {
  const frozenCommand = frozenCheck(item);
  if (!frozenCommand && !supplement) return { state: 'pass', green: true, checked: false, report: '' };
  let command;
  let policy;
  let config;
  try { policy = itemPolicy(root, item); config = policy.config; command = frozenCommand ? followRenames(root, mappedCheck(root, frozenCommand, { commit: item.item_commit }), { base: item.item_claim_head, commit: item.item_commit }).command : '';
    if (supplement) command = [command, supplement].filter(Boolean).map(part => `(\n${part}\n)`).join(' && '); }
  catch { return checkResult('unverified', 'policy', '', '', { root, item }); }
  if (gateLease?.runner) {
    let descriptor;
    try { descriptor = privateGuard(guard); }
    catch {
      const problem = 'the frozen guard descriptor is invalid or escapes its private checkout';
      return { ...checkResult('unverified', problem, '', '', { root, item }), guardProblem: problem };
    }
    if (mutate && !descriptor) return checkResult('unverified', 'a remote mutation requires a frozen declarative guard', '', '', { root, item });
    // A runner run is pulled and awaited, so this branch returns a promise; a local check returns its result at once.
    const ran = runnerPrivateCheck(root, item, command, policy, gateLease, descriptor, waitMs, checkResult);
    return testTiers ? ran.then(result => ({ ...result, testTiers, executionCommand: command })) : ran;
  }
  const install = config.check.install;
  const timeout = frozenCheckCeilingMs(config);
  // Retain the physical root before cleanup; Node TAP resolves symlinks in test locations.
  const scratch = realpathSync(scratchFolder('pullboard-criterion-'));
  const copy = join(scratch, 'repo');
  const home = join(scratch, 'home');
  mkdirSync(home, { mode: 0o700 });
  const machine = environmentAdapter();
  const verifierHome = machine.get('HOME') ?? machine.get('USERPROFILE');
  const npmCache = machine.get('npm_config_cache') ?? join(verifierHome ?? home, '.npm');
  const env = { ...cleanGitEnvironment(), HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(home, 'machine'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', npm_config_cache: npmCache };
  if (gateLease) Object.assign(env, gateSlotEnvironment(gateLease),
    gateLease.testOutcomeRunId ? { [TIMING_RUN_ID_ENV]: gateLease.testOutcomeRunId } : {});
  else if (gateSlotHeld) env[GATE_SLOT_HELD_ENV] = '1';
  delete env.PULLBOARD_RELAY_TOKEN;
  if (testTiers) delete env.NODE_TEST_CONTEXT;
  let installOutput = '';
  let checkOutput = '';
  let environment = null;
  let testRuntimes = null;
  const checkStartedAt = Date.now();
  let installLogPath = '';
  let checkLogPath = '';
  let timingProfile = { files: [], tests: [] };
  let checkedSourceReady = false;
  let trustedTrunk = null;
  let executed = false;
  let exitCode = null;
  /** Format one completed check phase with the private captures and durable artifact locations. */
  const finish = (state, stage) => {
    const runner = timingRunner(command);
    const events = checkLogPath && existsSync(checkLogPath) ? timingFromLog(checkLogPath, runner) : timingFromOutput(checkOutput, runner);
    timingProfile = { ...events, wallMs: Math.max(0, Date.now() - checkStartedAt), environment };
    const result = checkResult(state, stage, installOutput, checkOutput, { root, item, commandRoot: copy, installLogPath, checkLogPath, timingProfile, waitMs,
      environment, testRuntimes, executed, exitCode, proofCounts: privateCheckCounts(checkLogPath, checkOutput), executionSourceUnchanged: checkedSourceReady && privateSourceUnchanged(copy, item.item_commit, env) });
    return testTiers ? { ...result, testTiers, executionCommand: command } : result;
  };
  try {
    const common = policyGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    const clone = gitSpawnSync(['clone', '--quiet', '--shared', '--no-checkout', common, copy], { env, stdio: 'ignore' });
    if (clone.status === 0) {
      const retainedTrunk = trunkRef(root);
      if (retainedTrunk) {
        const savedTrunk = gitSpawnSync(['config', '--local', '--replace-all', 'pullboard.trunk', retainedTrunk], {
          cwd: copy, env, stdio: 'ignore',
        });
        if (savedTrunk.status !== 0) return finish('unverified', 'retained trunk could not be copied into the private clone');
        // Cloning a detached primary HEAD omits its local trunk branch, even when the source has it.
        const retainedTip = gitSpawnSync(['--no-replace-objects', 'rev-parse', '--verify', '--quiet', `${retainedTrunk}^{commit}`], {
          cwd: root, env, encoding: 'utf8',
        });
        if (retainedTip.status === 0 && retainedTrunk.startsWith('refs/heads/')) {
          const savedTip = gitSpawnSync(['update-ref', retainedTrunk, retainedTip.stdout.trim()], {
            cwd: copy, env, stdio: 'ignore',
          });
          if (savedTip.status !== 0) return finish('unverified', 'retained trunk tip could not be copied into the private clone');
          trustedTrunk = { ref: retainedTrunk, commit: retainedTip.stdout.trim() };
        }
      }
    }
    const checkout = clone.status === 0 && gitSpawnSync(['checkout', '--quiet', '--detach', item.item_commit], { cwd: copy, env, stdio: 'ignore' });
    if (!checkout || checkout.status !== 0) return finish('unverified', 'clone or checkout could not start');
    // The detached private primary has no main checkout; carry the controller's actual retained trunk for test budgets.
    if (trustedTrunk) {
      const record = runnerPolicyRecord({ id: `private-${randomUUID()}`, commit: item.item_commit,
        tree: policyGit(copy, ['rev-parse', 'HEAD^{tree}']).trim(), trunk: trustedTrunk });
      writeFileSync(join(copy, '.git', RUNNER_POLICY_FILE), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    }
    if (mutate) {
      const reason = mutate(copy);
      if (reason) return finish('unverified', reason);
    }
    checkedSourceReady = !mutate;
    const deadline = Date.now() + timeout;
    if (install) {
      installLogPath = join(scratch, 'install.log');
      const run = runPrivateCommand(copy, env, install, Math.max(1, deadline - Date.now()), installLogPath);
      installOutput = run.output;
      if (run.error?.code === 'ETIMEDOUT') return finish('unverified', 'install timed out');
      if (run.error) return finish('unverified', `install could not start (${run.error.code})`);
      if (run.logError) return finish('unverified', `install output could not be saved (${run.logError.code})`);
      if (run.status !== 0) return finish('unverified', 'install failed');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return finish('unverified', `check timed out before it started against its ${(timeout / 1000).toFixed(1)} second ceiling: ${frozenCommand}`);
    checkLogPath = join(scratch, 'check.log');
    const checkRunStartedAt = Date.now();
    const run = runPrivateCommand(copy, env, command, remaining, checkLogPath);
    executed = run.executed === true;
    exitCode = run.status ?? null;
    environment = environmentProblem(run.environment) ? null : run.environment;
    testRuntimes = run.testRuntimes ?? null;
    checkOutput = run.output;
    if (run.error?.code === 'ETIMEDOUT') return finish('unverified', `check timed out after ${((Date.now() - checkRunStartedAt) / 1000).toFixed(1)} seconds against its ${(timeout / 1000).toFixed(1)} second ceiling: ${frozenCommand}`);
    if (run.error) return finish('unverified', `check could not start (${run.error.code})`);
    if (run.logError) return finish('unverified', `check output could not be saved (${run.logError.code})`);
    if (run.status === null) return finish('unverified', 'check could not start (CHECK_RUNNER)');
    return finish(run.status === 0 ? 'pass' : 'red', run.status === 0 ? 'check' : `check failed (exit ${run.status})`);
  } catch { return finish('unverified', 'check could not complete'); }
  finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Count only the check phase; install output is setup and cannot supply verdict test totals. */
function privateCheckCounts(path, capture) {
  try { return proofCounts(path && existsSync(path) ? logLines(path) : capture); }
  catch { return { passed: null, failed: null, skipped: null }; }
}

/** Run one shell command in a bounded private process group and capture its combined output. */
function runPrivateCommand(root, env, command, timeout, logPath) {
  const pidFile = logPath + '.pid';
  try {
    // The worker drains pipes even after its capture cap, so noisy successful commands still pass.
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./check/worker.js', import.meta.url))], {
      cwd: root, env, input: JSON.stringify({ command, timeout, pidFile, logPath }), encoding: 'utf8',
      timeout: timeout + 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
    });
    if (run.error) return { status: null, error: { code: run.error.code }, output: '' };
    try { return JSON.parse(run.stdout); }
    catch { return { status: null, error: { code: 'CHECK_RUNNER' }, output: '' }; }
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* The private command group has already exited. */ }
      }
      rmSync(pidFile, { force: true });
    }
  }
}

const CHECK_LOG_READ_BYTES = 32 * 1024;
const CHECK_LINE_SCAN_LIMIT = 64 * 1024;
const CHECK_OVERSIZED_LINE = '[redacted output line exceeds 64 KiB safe-scan limit]';

/** Replace a detected secret line without including its value in diagnostics. */
function scanOutputLine(line, path, number) {
  if (Buffer.byteLength(line, 'utf8') > CHECK_LINE_SCAN_LIMIT) return CHECK_OVERSIZED_LINE;
  const findings = secretsIn([{ path, line: number, text: line }]);
  if (!findings.length) return line;
  const labels = findings.map(finding => finding.slice(0, finding.lastIndexOf(' at ')));
  return `[redacted ${labels.join(', ')}]`;
}

/** Summarize bounded private command output for verifier and doctor diagnostics. */
function secretScanned(output, path) {
  return output.split('\n').map((line, index) => scanOutputLine(line, path, index + 1)).join('\n');
}

/** Stream one worker log into a private artifact while retaining only its bounded sanitized tail. */
function streamSanitizedLog(path, fallback, label, writeArtifact, onLine = () => {}) {
  const decoder = new StringDecoder('utf8');
  const tail = [];
  let line = '';
  let lineBytes = 0;
  let lineNumber = 1;
  let oversized = false;
  let pending = '';
  let sawOutput = false;
  let finishedWithNewline = false;

  /** Flush buffered sanitized text using complete synchronous writes. */
  function flush() {
    if (!pending || !writeArtifact) { pending = ''; return; }
    const buffer = Buffer.from(pending, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeArtifact(buffer, offset);
      if (written <= 0) throw new Error('diagnostic artifact write made no progress');
      offset += written;
    }
    pending = '';
  }

  /** Retain one bounded tail line and append its scanned form to the artifact buffer. */
  function emitLine(newline) {
    const sanitized = oversized ? CHECK_OVERSIZED_LINE : scanOutputLine(line, label, lineNumber);
    onLine(sanitized);
    const bounded = sanitized.length > 2000
      ? `${sanitized.slice(0, 1000)}…[line truncated]…${sanitized.slice(-1000)}` : sanitized;
    tail.push(bounded);
    if (tail.length > 40) tail.shift();
    pending += sanitized + (newline ? '\n' : '');
    sawOutput = true;
    line = '';
    lineBytes = 0;
    oversized = false;
    lineNumber += 1;
    if (pending.length >= CHECK_LOG_READ_BYTES) flush();
  }

  /** Consume decoded text without retaining an oversized logical line. */
  function consume(text) {
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf('\n', start);
      const stop = end < 0 ? text.length : end;
      if (!oversized) {
        const part = text.slice(start, stop);
        const partBytes = Buffer.byteLength(part, 'utf8');
        if (lineBytes + partBytes > CHECK_LINE_SCAN_LIMIT) {
          line = '';
          lineBytes = 0;
          oversized = true;
        } else {
          line += part;
          lineBytes += partBytes;
        }
      }
      if (end < 0) {
        if (stop > start) finishedWithNewline = false;
        break;
      }
      emitLine(true);
      finishedWithNewline = true;
      start = end + 1;
    }
  }

  /** Decode a bounded fallback capture when the worker log is unavailable. */
  function feedFallback(text) {
    consume(decoder.write(Buffer.from(text, 'utf8')));
    consume(decoder.end());
    if (line || oversized) emitLine(false);
    else if (finishedWithNewline) { tail.push(''); if (tail.length > 40) tail.shift(); }
  }

  if (path && existsSync(path)) {
    const input = openSync(path, 'r');
    const chunk = Buffer.alloc(CHECK_LOG_READ_BYTES);
    try {
      let count;
      while ((count = readSync(input, chunk, 0, chunk.length, null)) > 0) {
        consume(decoder.write(chunk.subarray(0, count)));
      }
      consume(decoder.end());
      if (line || oversized) emitLine(false);
      else if (finishedWithNewline) { tail.push(''); if (tail.length > 40) tail.shift(); }
    } finally { closeSync(input); }
  } else feedFallback(fallback);
  flush();
  return { tail, sawOutput };
}

/** Capture the private clone before cleanup, so a diagnostic cannot call edited source an unchanged-head measurement. */
function privateSourceUnchanged(root, commit, env) {
  const state = gitSpawnSync(['--no-replace-objects', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'], { cwd: root, env, encoding: 'utf8' });
  if (state.status !== 0) return false;
  const lines = state.stdout.split('\n').filter(Boolean);
  return lines.includes('# branch.oid ' + commit) && lines.every(line => line.startsWith('# '));
}

/** Persist a sanitized full diagnostic outside the temporary checkout so a refusal can name it. */
function checkResult(state, stage, installCapture, checkCapture, { root = '', item = {}, commandRoot = root, installLogPath = '', checkLogPath = '', timingProfile = null, waitMs = 0, environment = null, testRuntimes = null, executed = false, exitCode = null, proofCounts = null, executionSourceUnchanged } = {}) {
  const boundedInstall = secretScanned(installCapture, 'check install capture');
  const boundedCheck = secretScanned(checkCapture, 'frozen check capture');
  const install = digestOf(boundedInstall) || '(no output)';
  const check = digestOf(boundedCheck) || '(not run or no output)';
  const report = `install output:\n${install}\ncheck output:\n${check}`;
  let sandboxBlocked = null;
  let outputPath = null;
  let outputError = null;
  let artifactFd = null;
  if (root && (state !== 'pass' || checkLogPath || timingProfile)) {
    try {
      const common = policyGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
      const directory = join(common, 'pullboard', 'check-output');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      outputPath = join(directory, `check-${item.item_id ?? 'unknown'}-${String(item.item_commit ?? 'unknown').slice(0, 12)}-${randomUUID()}.log`);
      artifactFd = openSync(outputPath, 'wx', 0o600);
    } catch (error) {
      outputPath = null;
      outputError = error.code ?? 'CHECK_DIAGNOSTIC';
    }
  }
  /** Write complete text to the private artifact, handling short synchronous writes. */
  const appendArtifact = (text) => {
    if (artifactFd === null) return;
    const buffer = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(artifactFd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error('diagnostic artifact write made no progress');
      offset += written;
    }
  };
  /** Give a missing phase the same explicit placeholder used by the former complete-string path. */
  const writePhase = (title, path, capture, label, absentText) => {
    appendArtifact(`${title}:\n`);
    const scan = sandboxBlockedScanner(commandRoot);
    const result = streamSanitizedLog(path, capture, label, artifactFd === null ? null : (buffer, offset) => {
      const written = writeSync(artifactFd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error('diagnostic artifact write made no progress');
      return written;
    }, line => { if (state !== 'pass' && title === (stage.startsWith('install') ? 'install' : 'check')) sandboxBlocked ??= scan(line); });
    if (!result.sawOutput) appendArtifact(`${absentText}\n`);
    return result;
  };
  let installLog;
  let checkLog;
  let profilePath = null;
  try {
    installLog = writePhase('install', installLogPath, installCapture, 'check install output', '(no output)');
    appendArtifact('\n');
    checkLog = writePhase('check', checkLogPath, checkCapture, 'frozen check output',
      !checkLogPath && !checkCapture ? '(not run or no output)' : '(no output)');
    if (artifactFd !== null) closeSync(artifactFd);
    if (outputPath && timingProfile) {
      profilePath = `${outputPath}.profile.json`;
      const profile = writeTimingProfile(profilePath, { ...timingProfile, waitMs: Math.max(0, Math.round(waitMs)) });
      timingProfile = profile;
    }
  } catch (error) {
    if (artifactFd !== null) { try { closeSync(artifactFd); } catch { /* The descriptor may already be closed. */ } }
    if (outputPath) { try { rmSync(outputPath, { force: true }); } catch { /* Keep the refusal typed if cleanup also fails. */ } }
    if (profilePath) { try { rmSync(profilePath, { force: true }); } catch { /* Keep the refusal typed if cleanup also fails. */ } }
    profilePath = null;
    outputPath = null;
    outputError = error.code ?? 'CHECK_DIAGNOSTIC';
    installLog = streamSanitizedLog('', installCapture, 'check install capture', null);
    checkLog = streamSanitizedLog('', checkCapture, 'frozen check capture', null);
  }
  const relevant = stage.startsWith('install') ? installLog : (checkLog.sawOutput ? checkLog : installLog);
  const outputTail = relevant.tail.map((line) => line.length > 2000
    ? `${line.slice(0, 1000)}…[line truncated]…${line.slice(-1000)}` : line).join('\n') || '(no output)';
  const failure = state === 'red' ? 'failed' : /timed out/u.test(stage) ? 'timed out'
    : /could not start/u.test(stage) ? "couldn't start" : state === 'unverified' ? 'could not be verified' : 'passed';
  const output = `install output:\n${boundedInstall || '(no output)'}\ncheck output:\n${boundedCheck || '(not run or no output)'}`;
  return { sandboxBlocked, state, green: state === 'pass', checked: true, stage, failure, report, output, outputTail, outputPath, outputError, profilePath,
    executionRoot: commandRoot, environment, testRuntimes, executed, exitCode, proofCounts, ...(executionSourceUnchanged === undefined ? {} : { executionSourceUnchanged }),
    profile: timingProfile ? { ...timingProfile, profilePath } : null };
}

/** The runner's one door to Git for the hand-off stages: they launch through the adapter, never a literal launch of their own [C7]. */
export function runnerGit(args, options) { return gitSpawnSync(args, options); }
