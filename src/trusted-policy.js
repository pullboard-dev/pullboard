/** Coordinator policy and immutable submission checks cannot come from a builder's candidate [V4,V16,L3,M3]. */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { digestOf, writeTimingProfile } from './gate.js';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { configFromSource } from './config.js';
import { cleanGitEnvironment, gitConfig, invalidateGitFacts, mainCheckout, refuseGrafts } from './git.js';
import { secretsIn } from './hooks.js';
import { outOfLane } from './lanes.js';
import { Refused } from './refused.js';

/** Read raw Git output, retaining NUL-delimited names without exposing Git diagnostics. */
function policyGit(root, args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Refused('NO_POLICY', 'the committed coordinator policy or claim base is missing; restore its Git objects or ask the coordinator to refreeze the item');
  return result.stdout;
}

/** Resolve the primary checkout's committed HEAD, independently of a linked or detached checkout. */
export function mainPolicy(root) {
  const checkout = mainCheckout(root);
  if (!checkout) throw new Refused('NO_POLICY', 'the coordinator checkout is detached for review; ask it to return to its main branch before claiming or running the project gate');
  if (!checkout.commit) throw new Refused('NO_POLICY', 'the coordinator checkout has no commit on ' + checkout.branch + '; create its first commit before claiming or running the project gate');
  return policyAt(root, checkout.commit);
}

/** Retain the local primary branch outside replicated board data and read-only diagnostics [B34,V6]. */
export function trunkRef(root, branch) {
  const read = gitConfig(root, 'pullboard.trunk', { local: true, clean: true, flags: false, noReplace: true });
  if (read.status !== 0 && read.status !== 1) throw new Refused('NO_POLICY', 'the retained trunk cannot be read; restore the local Git configuration and retry');
  const current = read.status === 0 ? read.stdout.trim() : null;
  if (branch === undefined || branch === current) return current;
  const saved = spawnSync('git', ['--no-replace-objects', 'config', '--local', '--replace-all', 'pullboard.trunk', branch], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8',
  });
  invalidateGitFacts();
  if (saved.status !== 0) throw new Refused('NO_POLICY', 'the trunk branch cannot be recorded; restore writable local Git configuration and retry');
  return branch;
}

/** Refuse a candidate that conflicts with the current primary branch, without touching an index or worktree [B34,V6]. */
export function requireTrunkMerge(root, commit, retainedRef = trunkRef(root)) {
  const checkout = mainCheckout(root);
  const branchRef = checkout?.branch ?? retainedRef;
  if (!branchRef?.startsWith('refs/heads/')) throw new Refused('NO_TRUNK', 'no trunk branch was recorded; check out the trunk branch in the main checkout once and run pullboard inbox');
  const tip = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', branchRef + '^{commit}'], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' });
  if (tip.status !== 0) throw new Refused('NO_TRUNK', 'the recorded trunk branch has no readable tip; check out the trunk branch in the main checkout once and run pullboard inbox');
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.quotepath=false', 'merge-tree', '--write-tree', '--name-only', '-z', tip.stdout.trim(), commit], {
    cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status === 0) return;
  if (result.status !== 1) throw new Refused('MERGE_CHECK_FAILED', 'Git could not check the candidate against the trunk; use Git 2.38 or newer, restore its objects and retry');
  const records = result.stdout.split('\0').slice(1);
  const end = records.indexOf('');
  const files = records.slice(0, end < 0 ? records.length : end).map(path => JSON.stringify(path));
  const branch = branchRef.replace(/^refs\/heads\//, '');
  throw new Refused('MERGE_CONFLICT', `the candidate conflicts with the current trunk ${branch} in ${files.join(', ') || 'unresolved files'}; merge the trunk into your branch, resolve these files, commit and resubmit`);
}

/** Re-read coordinator settings from a pinned Git object; never from the candidate filesystem. */
export function policyAt(root, commit) {
  if (!/^[0-9a-f]{40,64}$/.test(commit ?? '')) throw new Refused('NO_POLICY', 'this item has no recorded claim base; ask the coordinator to refreeze it and claim it again');
  const config = configFromSource(policyGit(root, ['show', commit + ':pullboard.json']));
  return { version: 1, commit, config };
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

/** Verified dependencies may contribute their own unchanged lane files before the coordinator merges them [N16]. */
export function dependencySnapshots(db, item) {
  const ids = String(item.item_after ?? '').split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  return ids.flatMap(id => {
    const row = db.prepare("SELECT item_lane, item_claim_head, item_commit FROM item WHERE item_id=? AND item_status='verified' AND EXISTS (SELECT 1 FROM verdict WHERE item_id=? AND verdict_decision='ACCEPT' AND verdict_commit=item.item_commit)").get(id, id);
    return row?.item_claim_head && /^[0-9a-f]{40,64}$/.test(row.item_commit ?? '')
      ? [{ lane: row.item_lane, base: row.item_claim_head, commit: row.item_commit }] : [];
  });
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
 * @param {{ waitMs?: number }} [options] - Queue wait before the private check started.
 */
export function checkAtCommit(root, item, { waitMs = 0 } = {}) {
  const command = frozenCheck(item);
  if (!command) return { state: 'pass', green: true, checked: false, report: '' };
  let config;
  try { config = itemPolicy(root, item).config; }
  catch { return checkResult('unverified', 'policy', '', '', { root, item }); }
  const install = config.check.install;
  const timeout = config.check.timeoutMs;
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard-criterion-'));
  const copy = join(scratch, 'repo');
  const home = join(scratch, 'home');
  mkdirSync(home, { mode: 0o700 });
  const verifierHome = process.env.HOME ?? process.env.USERPROFILE;
  const npmCache = process.env.npm_config_cache ?? join(verifierHome ?? home, '.npm');
  const timingEventsPath = join(scratch, 'check-timings.events.json');
  const env = { ...cleanGitEnvironment(), HOME: home, PULLBOARD_HOME: join(home, '.pullboard'), PULLBOARD_MACHINE_HOME: join(home, 'machine'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', npm_config_cache: npmCache, PULLBOARD_TEST_TIMING_PROFILE: timingEventsPath };
  delete env.PULLBOARD_RELAY_TOKEN;
  let installOutput = '';
  let checkOutput = '';
  const checkStartedAt = Date.now();
  let installLogPath = '';
  let checkLogPath = '';
  let timingProfile = { files: [], tests: [] };
  /** Format one completed check phase with the private captures and durable artifact locations. */
  const finish = (state, stage) => {
    const events = readTimingProfiles(timingEventsPath);
    timingProfile = { ...events, wallMs: Math.max(0, Date.now() - checkStartedAt) };
    return checkResult(state, stage, installOutput, checkOutput, { root, item, installLogPath, checkLogPath, timingProfile, waitMs });
  };
  try {
    const common = policyGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    const clone = spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', common, copy], { env, stdio: 'ignore' });
    const checkout = clone.status === 0 && spawnSync('git', ['checkout', '--quiet', '--detach', item.item_commit], { cwd: copy, env, stdio: 'ignore' });
    if (!checkout || checkout.status !== 0) return finish('unverified', 'clone or checkout could not start');
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
    checkOutput = run.output;
    if (run.error?.code === 'ETIMEDOUT') return finish('unverified', 'check timed out');
    if (run.error) return finish('unverified', `check could not start (${run.error.code})`);
    if (run.logError) return finish('unverified', `check output could not be saved (${run.logError.code})`);
    if (run.status === null) return finish('unverified', 'check could not start (CHECK_RUNNER)');
    return finish(run.status === 0 ? 'pass' : 'red', run.status === 0 ? 'check' : `check failed (exit ${run.status})`);
  } catch { return finish('unverified', 'check could not complete'); }
  finally {
    removeTimingProfiles(timingEventsPath);
    rmSync(scratch, { recursive: true, force: true });
  }
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

/** Read every reporter invocation produced by this private check, including nested npm scripts.
 * @param {string} prefix
 * @returns {{ files: Array<object>, tests: Array<object> }}
 */
function readTimingProfiles(prefix) {
  const directory = dirname(prefix);
  const base = `${basename(prefix)}.`;
  let names = [];
  try { names = readdirSync(directory).filter(name => name.startsWith(base) && name.endsWith('.json')); } catch { return { files: [], tests: [] }; }
  const profiles = [];
  for (const name of names) {
    try { profiles.push(JSON.parse(readFileSync(join(directory, name), 'utf8'))); } catch { /* Ignore a reporter interrupted with its process. */ }
  }
  return { files: profiles.flatMap(profile => Array.isArray(profile.files) ? profile.files : []), tests: profiles.flatMap(profile => Array.isArray(profile.tests) ? profile.tests : []) };
}

/** Remove the private reporter artifacts before the scratch clone is discarded.
 * @param {string} prefix
 */
function removeTimingProfiles(prefix) {
  const directory = dirname(prefix);
  const base = `${basename(prefix)}.`;
  try { for (const name of readdirSync(directory)) if (name.startsWith(base) && name.endsWith('.json')) rmSync(join(directory, name), { force: true }); } catch { /* No reporter artifacts were created. */ }
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
function streamSanitizedLog(path, fallback, label, writeArtifact) {
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

/** Persist a sanitized full diagnostic outside the temporary checkout so a refusal can name it. */
function checkResult(state, stage, installCapture, checkCapture, { root = '', item = {}, installLogPath = '', checkLogPath = '', timingProfile = null, waitMs = 0 } = {}) {
  const boundedInstall = secretScanned(installCapture, 'check install capture');
  const boundedCheck = secretScanned(checkCapture, 'frozen check capture');
  const install = digestOf(boundedInstall) || '(no output)';
  const check = digestOf(boundedCheck) || '(not run or no output)';
  const report = `install output:\n${install}\ncheck output:\n${check}`;
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
    const result = streamSanitizedLog(path, capture, label, artifactFd === null ? null : (buffer, offset) => {
      const written = writeSync(artifactFd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error('diagnostic artifact write made no progress');
      return written;
    });
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
      const profile = writeTimingProfile(profilePath, { version: 1, waitMs: Math.max(0, Math.round(waitMs)), wallMs: timingProfile.wallMs ?? null, files: timingProfile.files ?? [], tests: timingProfile.tests ?? [] });
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
  return { state, green: state === 'pass', checked: true, stage, failure, report, output, outputTail, outputPath, outputError, profilePath, profile: timingProfile ? { ...timingProfile, profilePath } : null };
}
