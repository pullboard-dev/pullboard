import { privateGuard } from './runner-private-mode.js';
import { runnerPrivateCheck } from './runner-private-check.js';
import {
  mainPolicy,
  policyAt,
  policyGit,
  trunkRef,
} from './trusted-policy-read.js';
export { mainPolicy, policyAt, trunkRef } from './trusted-policy-read.js';
/** Coordinator policy and immutable submission checks cannot come from a builder's candidate [V4,V16,L3,M3]. */
import { randomUUID } from 'node:crypto';
import { environmentProblem } from './execution-environment.js';
import { spawnSync } from 'node:child_process';
import {
  digestOf,
  writeTimingProfile,
} from './gate-output.js';
import { sandboxBlockedScanner } from './sandbox-denial.js';
import {
  timingFromOutput,
  timingFromLog,
  logLines,
  timingRunner,
} from './timing.js';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import {
  GATE_SLOT_HELD_ENV,
  gateSlotEnvironment,
} from './resources.js';
import {
  cleanGitEnvironment,
  mainCheckout,
  refuseGrafts,
} from './git.js';
import { secretsIn } from './hooks.js';
import { outOfLane } from './lanes.js';
import { Refused } from './refused.js';
import { proofCounts } from './proof-provenance.js';

/** Resolve the trunk snapshot and refuse a conflict without touching an index or worktree [B34,V6].
 *
 * Returning the exact ref and tip lets later candidate checks use the same snapshot this merge
 * check validated.
 *
 * @param {string} root
 * @param {string} commit
 * @param {string} [retainedRef]
 * @returns {{ ref: string, commit: string }}
 */
export function requireTrunkMerge(root, commit, retainedRef = trunkRef(root)) {
  const { files, ...trunk } = trunkMerge(root, commit, retainedRef);
  if (!files) return trunk;
  const branch = trunk.ref.replace(/^refs\/heads\//, '');
  throw new Refused('MERGE_CONFLICT', `the candidate conflicts with the current trunk ${branch} in ${files.map(path => JSON.stringify(path)).join(', ') || 'unresolved files'}; merge the trunk into your branch, resolve these files, commit and resubmit`);
}

/** Merge a commit onto the trunk tip in memory: the ref, the tip, and the conflicting files or null [B34,V6].
 *
 * @param {string} root
 * @param {string} commit
 * @param {string} [retainedRef]
 * @returns {{ ref: string, commit: string, files: string[] | null }}
 */
export function trunkMerge(root, commit, retainedRef = trunkRef(root)) {
  const checkout = mainCheckout(root);
  const branchRef = checkout?.branch ?? retainedRef;
  if (!branchRef?.startsWith('refs/heads/')) throw new Refused('NO_TRUNK', 'no trunk branch was recorded; check out the trunk branch in the main checkout once and run pullboard inbox');
  const tip = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', branchRef + '^{commit}'], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' });
  if (tip.status !== 0) throw new Refused('NO_TRUNK', 'the recorded trunk branch has no readable tip; check out the trunk branch in the main checkout once and run pullboard inbox');
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.quotepath=false', 'merge-tree', '--write-tree', '--name-only', '-z', tip.stdout.trim(), commit], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status === 0) return { ref: branchRef, commit: tip.stdout.trim(), files: null };
  if (result.status !== 1) throw new Refused('MERGE_CHECK_FAILED', 'Git could not check the candidate against the trunk; use Git 2.38 or newer, restore its objects and retry');
  const records = result.stdout.split('\0').slice(1);
  const end = records.indexOf('');
  return { ref: branchRef, commit: tip.stdout.trim(), files: records.slice(0, end < 0 ? records.length : end) };
}

/** Use new claims' frozen policy; legacy claims retain their committed claim-base settings. */
export function itemPolicy(root, item) {
  let frozen;
  try { frozen = JSON.parse(item.item_frozen ?? 'null'); }
  catch { throw new Refused('NO_POLICY', 'the frozen criterion is invalid; ask the coordinator to refreeze this item'); }
  return policyAt(root, frozen?.policy?.commit ?? item.item_claim_head);
}

/** Compare a path's mode and object, including deletions, against an authenticated main snapshot. */
function pathObject(root, commit, path) {
  return policyGit(root, ['ls-tree', '-z', commit, '--', ':(literal)' + path]);
}

/** Enforce the complete claim-base diff; accepted-main merges may carry only identical foreign objects. */
export function submissionPaths(root, item, commit, { config, mainCommit, dependencies = [] } = {}) {
  refuseGrafts(root);
  const policy = itemPolicy(root, item);
  const base = item.item_claim_head;
  if (!/^[0-9a-f]{40,64}$/.test(base ?? '')) throw new Refused('NO_POLICY', 'this item has no claim base; ask the coordinator to refreeze it and claim again');
  policyGit(root, ['rev-parse', '--verify', base + '^{commit}']);
  const changed = [base, policy.commit].flatMap(start => policyGit(root, ['diff', '--no-renames', '--name-only', '-z', start, commit, '--']).split('\0').filter(Boolean));
  const paths = [...new Set(changed)];
  const ownership = config ?? policy.config;
  const foreign = paths.filter(path => outOfLane(ownership, item.item_lane, [path]).length);
  const snapshot = mainCommit ?? policy.commit;
  policyAt(root, snapshot); // Reject a malformed historical proof before it can become a Git argument.
  const accepted = dependencies.map(dependency => ({ ...dependency,
    paths: new Set(policyGit(root, ['diff', '--no-renames', '--name-only', '-z', dependency.base, dependency.commit, '--']).split('\0').filter(Boolean)),
  }));
  const denied = foreign.filter(path => {
    const object = pathObject(root, commit, path);
    if (object === pathObject(root, snapshot, path)) return false;
    return !accepted.some(dependency => dependency.paths.has(path)
      && !outOfLane(ownership, dependency.lane, [path]).length
      && object === pathObject(root, dependency.commit, path));
  });
  if (denied.length) throw new Refused('OUTSIDE_LANE', 'outside the ' + item.item_lane + ' lane: ' + outOfLane(ownership, item.item_lane, denied).join(', ') + '; shout the owner and restore these paths before submitting');
  return paths;
}

/** Verified dependencies may contribute their own unchanged lane files, including through a verified chain [N16]. */
export function dependencySnapshots(db, item) {
  const pending = String(item.item_after ?? '').split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  const visited = new Set();
  const snapshots = [];
  while (pending.length) {
    const id = pending.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const row = db.prepare("SELECT item_lane, item_claim_head, item_commit, item_after FROM item WHERE item_id=? AND item_status='verified' AND EXISTS (SELECT 1 FROM verdict WHERE item_id=? AND verdict_decision='ACCEPT' AND verdict_commit=item.item_commit)").get(id, id);
    if (!row?.item_claim_head || !/^[0-9a-f]{40,64}$/.test(row.item_commit ?? '')) continue;
    snapshots.push({ lane: row.item_lane, base: row.item_claim_head, commit: row.item_commit });
    pending.push(...String(row.item_after ?? '').split(',').map(Number).filter(dependency => Number.isSafeInteger(dependency) && dependency > 0));
  }
  return snapshots;
}

/** Read the command frozen with the criterion, preventing a later edit from changing its proof. */
export function frozenCheck(item) {
  let frozen;
  try { frozen = JSON.parse(item.item_frozen ?? 'null'); } catch { return ''; }
  return frozen?.check ?? (item.item_frozen ? '' : item.item_check ?? '');
}

/** Run the frozen check at the exact submitted commit in a private clone, leaving live worktrees untouched.
 * @param {string} root
 * @param {object} item
 * @param {{ waitMs?: number, gateSlotHeld?: boolean, gateLease?: object, mutate?: (directory: string) => string, guard?: object }} [options] - Queue wait before the private check started;
 *   mutate changes the scratch tree after checkout (a guard revert) and returns a reason when it cannot [C7,V4].
 */
export function checkAtCommit(root, item, { waitMs = 0, gateSlotHeld = false, gateLease, mutate, guard } = {}) {
  const command = frozenCheck(item);
  if (!command) return { state: 'pass', green: true, checked: false, report: '' };
  let policy;
  let config;
  try { policy = itemPolicy(root, item); config = policy.config; }
  catch { return checkResult('unverified', 'policy', '', '', { root, item }); }
  if (gateLease?.runner) {
    let descriptor;
    try { descriptor = privateGuard(guard); }
    catch {
      const problem = 'the frozen guard descriptor is invalid or escapes its private checkout';
      return { ...checkResult('unverified', problem, '', '', { root, item }), guardProblem: problem };
    }
    if (mutate && !descriptor) return checkResult('unverified', 'a remote mutation requires a frozen declarative guard', '', '', { root, item });
    return runnerPrivateCheck(root, item, command, policy, gateLease, descriptor, waitMs, checkResult);
  }
  const install = config.check.install;
  const timeout = config.check.timeoutMs;
  // Retain the physical root before cleanup; Node TAP resolves symlinks in test locations.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-criterion-')));
  const copy = join(scratch, 'repo');
  const home = join(scratch, 'home');
  mkdirSync(home, { mode: 0o700 });
  const verifierHome = process.env.HOME ?? process.env.USERPROFILE;
  const npmCache = process.env.npm_config_cache ?? join(verifierHome ?? home, '.npm');
  const env = { ...cleanGitEnvironment(), HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(home, 'machine'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', npm_config_cache: npmCache };
  if (gateLease) Object.assign(env, gateSlotEnvironment(gateLease));
  else if (gateSlotHeld) env[GATE_SLOT_HELD_ENV] = '1';
  delete env.PULLBOARD_RELAY_TOKEN;
  let installOutput = '';
  let checkOutput = '';
  let environment = null;
  let testRuntimes = null;
  const checkStartedAt = Date.now();
  let installLogPath = '';
  let checkLogPath = '';
  let timingProfile = { files: [], tests: [] };
  let checkedSourceReady = false;
  let executed = false;
  let exitCode = null;
  /** Format one completed check phase with the private captures and durable artifact locations. */
  const finish = (state, stage) => {
    const runner = timingRunner(command);
    const events = checkLogPath && existsSync(checkLogPath) ? timingFromLog(checkLogPath, runner) : timingFromOutput(checkOutput, runner);
    timingProfile = { ...events, wallMs: Math.max(0, Date.now() - checkStartedAt), environment };
    return checkResult(state, stage, installOutput, checkOutput, { root, item, commandRoot: copy, installLogPath, checkLogPath, timingProfile, waitMs,
      environment, testRuntimes, executed, exitCode, proofCounts: privateCheckCounts(checkLogPath, checkOutput), executionSourceUnchanged: checkedSourceReady && privateSourceUnchanged(copy, item.item_commit, env) });
  };
  try {
    const common = policyGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    const clone = spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', common, copy], { env, stdio: 'ignore' });
    if (clone.status === 0) {
      const retainedTrunk = trunkRef(root);
      if (retainedTrunk) {
        const savedTrunk = spawnSync('git', ['config', '--local', '--replace-all', 'pullboard.trunk', retainedTrunk], {
          cwd: copy, env, stdio: 'ignore',
        });
        if (savedTrunk.status !== 0) return finish('unverified', 'retained trunk could not be copied into the private clone');
        // Cloning a detached primary HEAD omits its local trunk branch, even when the source has it.
        const retainedTip = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', `${retainedTrunk}^{commit}`], {
          cwd: root, env, encoding: 'utf8',
        });
        if (retainedTip.status === 0 && retainedTrunk.startsWith('refs/heads/')) {
          const savedTip = spawnSync('git', ['update-ref', retainedTrunk, retainedTip.stdout.trim()], {
            cwd: copy, env, stdio: 'ignore',
          });
          if (savedTip.status !== 0) return finish('unverified', 'retained trunk tip could not be copied into the private clone');
        }
      }
    }
    const checkout = clone.status === 0 && spawnSync('git', ['checkout', '--quiet', '--detach', item.item_commit], { cwd: copy, env, stdio: 'ignore' });
    if (!checkout || checkout.status !== 0) return finish('unverified', 'clone or checkout could not start');
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
    if (remaining <= 0) return finish('unverified', 'check timed out');
    checkLogPath = join(scratch, 'check.log');
    const run = runPrivateCommand(copy, env, command, remaining, checkLogPath);
    executed = run.executed === true;
    exitCode = run.status ?? null;
    environment = environmentProblem(run.environment) ? null : run.environment;
    testRuntimes = run.testRuntimes ?? null;
    checkOutput = run.output;
    if (run.error?.code === 'ETIMEDOUT') return finish('unverified', 'check timed out');
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
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./private-check-worker.js', import.meta.url))], {
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
  const state = spawnSync('git', ['--no-replace-objects', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'], { cwd: root, env, encoding: 'utf8' });
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
