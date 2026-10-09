/**
 * The gate (V4, C3, Q1, Q2, V18): the repo's check command and shared queue for gates and item checks. A green
 * run over a committed tree, with nothing untracked and nothing changed while it ran, leaves that
 * tree's id in the git dir, so the same tree is never checked twice. An agent sees a digest of the
 * run, not the run (V10): a passing suite's output costs tokens and says nothing.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gitChildEnv, gitPath, headTree, invalidateGitFacts, isClean, untracked } from './git.js';
import { secretsIn } from './hooks.js';
import { Refused } from './refused.js';
import { takeResource } from './resources.js';
import { loadMachineSettings } from './settings.js';
import { selectAffectedTests } from './affected-tests.js';

const STAMP = 'pullboard-gate-green';
const LOG = 'pullboard-gate.log';
const DIGEST_CHARS = 3000;
const TAIL_CHARS = 1000;
const LINE_CHARS = 300;
const FAILURE_RE = /fail|error|expected|received|assert|not ok|✗|×|cannot|undefined|exception/i;
// A passing test's own lines, whatever its name says: TAP's `ok N` and the `# Subtest:` before it.
const PASSING_RE = /^\s*(ok \d+\b|# Subtest:)/;
// Lines kept under a failure, where test runners say why: the message, expected and actual.
const CONTEXT_LINES = 10;

/**
 * The lines of a failure worth an agent's attention: each line that looks like a failure with the
 * lines under it that say why, then the end of the output, within one cap, so a refusal or a retry
 * carries the reason and not the whole log. Passing tests are skipped however they are named. The
 * end has its own share of the cap and every line is cut short, so no single long line can push the
 * summary out.
 *
 * @param {string} output
 * @returns {string}
 */
export function digestOf(output) {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line));
  const tail = [];
  let room = TAIL_CHARS;
  for (let at = lines.length - 1; at >= 0 && tail.length < 15 && lines[at].length < room; at -= 1) {
    tail.unshift(lines[at]);
    room -= lines[at].length + 1;
  }
  room = DIGEST_CHARS - (TAIL_CHARS - room);
  const body = lines.slice(0, lines.length - tail.length);
  const failing = [];
  for (let at = 0; at < body.length && failing.length < 40; at += 1) {
    if (PASSING_RE.test(body[at]) || !FAILURE_RE.test(body[at])) continue;
    const block = body.slice(at, at + CONTEXT_LINES + 1);
    const end = block.findIndex((line, n) => n > 0 && (PASSING_RE.test(line) || /^\s*(not ok \d+|\.\.\.)\s*$|^\s*not ok \d+/.test(line)));
    for (const line of end === -1 ? block : block.slice(0, end)) {
      if (line.length >= room) break;
      failing.push(line);
      room -= line.length + 1;
    }
    at += (end === -1 ? block.length : end) - 1;
  }
  return [...failing, ...tail].join('\n');
}

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

/**
 * Run a shell command in a checkout for a digest: both streams in one pipe, in order, read whole
 * however long, stdin closed so nothing waits on a person.
 *
 * @param {string} root
 * @param {string} command
 * @param {{ env?: NodeJS.ProcessEnv }} [options] - Additional child environment values.
 * @returns {{ isGreen: boolean, output: string, seconds: number }}
 */
export function runShell(root, command, { env = {} } = {}) {
  const started = Date.now();
  // Newlines, not spaces, around the command, so a trailing comment in it cannot swallow the `)`.
  const result = spawnSync(`(\n${command}\n) 2>&1`, { cwd: root, env: { ...gitChildEnv(root), ...env }, shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 2 ** 30 });
  invalidateGitFacts();
  return { isGreen: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, seconds: Math.round((Date.now() - started) / 1000) };
}

/** Replace a possible secret-bearing line before persisting a direct item-check log. */
function safeLog(output) {
  return output.split('\n').map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > 64 * 1024) return '[redacted output line exceeds 64 KiB safe-scan limit]';
    const findings = secretsIn([{ path: 'item check output', line: index + 1, text: line }]);
    return findings.length ? `[redacted ${findings.map(finding => finding.slice(0, finding.lastIndexOf(' at '))).join(', ')}]` : line;
  }).join('\n');
}

/** Run a command with Node's event reporter and persist its timing profile beside its log.
 * @param {string} root
 * @param {string} command
 * @param {{ waitMs?: number, artifactDirectory?: string, artifactPrefix?: string, persistLog?: boolean, profileFile?: string }} [options]
 * @returns {{ isGreen: boolean, output: string, seconds: number, profile: object, profilePath: string, logPath: string|null }}
 */
export function runProfiledShell(root, command, { waitMs = 0, artifactDirectory, artifactPrefix = 'pullboard-gate', persistLog = false, profileFile } = {}) {
  const directory = artifactDirectory ?? dirname(gitPath(root, LOG));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const eventsDirectory = join(directory, `.${artifactPrefix}-${id}.timings`);
  mkdirSync(eventsDirectory, { mode: 0o700 });
  const eventsPath = join(eventsDirectory, 'events.json');
  const profilePath = profileFile ?? join(directory, `${artifactPrefix}-${id}.profile.json`);
  const logPath = persistLog ? join(directory, `${artifactPrefix}-${id}.log`) : null;
  const started = Date.now();
  try {
    const run = runShell(root, command, { env: { PULLBOARD_TEST_TIMING_PROFILE: eventsPath } });
    const events = readTimingProfiles(eventsPath);
    const profile = writeTimingProfile(profilePath, {
      version: 1,
      waitMs: Math.max(0, Math.round(waitMs)),
      wallMs: Math.max(0, Date.now() - started),
      files: events.files,
      tests: events.tests,
    });
    if (logPath) writeFileSync(logPath, safeLog(run.output), { mode: 0o600 });
    return { ...run, profile, profilePath, logPath };
  } finally { rmSync(eventsDirectory, { recursive: true, force: true }); }
}

/** Persist one sanitized timing profile as a private artifact.
 * @param {string} path
 * @param {{ files?: Array<object>, tests?: Array<object>, [key: string]: any }} profile
 * @returns {object} The sanitized profile written to disk.
 */
export function writeTimingProfile(path, profile) {
  /** Sanitize one reporter-controlled string before persistence or display.
   * @param {unknown} value
   * @param {string} label
   * @returns {unknown}
   */
  const sanitize = (value, label) => {
    if (typeof value !== 'string') return value;
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024) return '[redacted profile field exceeds 64 KiB safe-scan limit]';
    const findings = secretsIn([{ path: `timing profile ${label}`, line: 1, text: value }]);
    return findings.length ? `[redacted ${findings.map(finding => finding.slice(0, finding.lastIndexOf(' at '))).join(', ')}]` : value;
  };
  /** Accept only measured, nonnegative durations from reporter events. */
  const validDuration = value => Number.isFinite(value) && value >= 0;
  const files = (profile.files ?? []).filter(file => typeof file?.path === 'string' && validDuration(file.durationMs))
    .map(file => ({ path: sanitize(file.path, 'file path'), durationMs: file.durationMs }));
  const tests = (profile.tests ?? []).filter(test => typeof test?.file === 'string' && typeof test?.name === 'string' && validDuration(test.durationMs))
    .map(test => ({ file: sanitize(test.file, 'test file'), name: sanitize(test.name, 'test name'), durationMs: test.durationMs, passed: test.passed === true }));
  const sanitized = {
    version: 1,
    waitMs: validDuration(profile.waitMs) ? profile.waitMs : 0,
    wallMs: validDuration(profile.wallMs) ? profile.wallMs : null,
    files,
    tests,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
  return sanitized;
}

/** Combine distinct Node reporter invocations whose names share a private per-run prefix. */
function readTimingProfiles(prefix) {
  const directory = dirname(prefix);
  const base = `${basename(prefix)}.`;
  const profiles = [];
  let names = [];
  try { names = readdirSync(directory).filter(name => name.startsWith(base) && name.endsWith('.json')); } catch { return { files: [], tests: [] }; }
  for (const name of names) {
    try { profiles.push(JSON.parse(readFileSync(join(directory, name), 'utf8'))); } catch { /* Ignore incomplete reporters from a killed test process. */ }
  }
  return { files: profiles.flatMap(profile => Array.isArray(profile.files) ? profile.files : []), tests: profiles.flatMap(profile => Array.isArray(profile.tests) ? profile.tests : []) };
}

/** Run work under the machine gate queue, keeping landing gates ahead of ordinary gates and item checks last.
 *
 * @param {string} root - Checkout used to locate the machine resource database.
 * @param {(lease: { waitMs: number }) => any | Promise<any>} action - Work to perform while holding a slot.
 * @param {{ landing?: boolean, itemCheck?: boolean, onWait?: (state: object) => void }} [options] - Queue class and progress reporter.
 * @returns {Promise<any>} The action's result after releasing its lease.
 */
export async function withGateSlot(root, action, { landing = false, itemCheck = false, onWait } = {}) {
  const capacityProvider = () => loadMachineSettings().gateSlots;
  const lease = await takeResource({
    name: 'gate',
    capacity: capacityProvider(),
    capacityProvider,
    scope: 'machine',
    root,
    repo: root,
    landing,
    itemCheck,
    allowIdleCapacityUpdate: true,
    onWait,
  });
  try {
    return await action(lease);
  } finally {
    lease.release();
  }
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
 * @param {{ trustStamp?: boolean, onWait?: (state: object) => void, landing?: boolean }} [options]
 * @returns {Promise<{ isGreen: boolean, isCached: boolean, output: string, seconds: number, log: string, profile?: object, profilePath?: string }>}
 */
export async function runGate(root, config, { trustStamp = true, onWait, landing = false } = {}) {
  if (!config.gate.trim()) {
    throw new Refused('NO_GATE', 'no gate configured; set "gate" in pullboard.json, e.g. "npm test"');
  }
  if (trustStamp && isStampedGreen(root)) return { isGreen: true, isCached: true, output: '', seconds: 0, log: '' };
  return await withGateSlot(root, (lease) => fullGateRun(root, config, trustStamp, { waitMs: lease.waitMs }), { landing, onWait });
}

/** Run a full gate while its caller owns the queue lease; only a full run may stamp its tree. */
function fullGateRun(root, config, trustStamp = false, { waitMs = 0, log = gitPath(root, LOG) } = {}) {
  if (trustStamp && isStampedGreen(root)) return { isGreen: true, isCached: true, output: '', seconds: 0, log: '' };
  const before = committedTree(root);
  const { isGreen, output, seconds, profile, profilePath } = runProfiledShell(root, config.gate, { waitMs, profileFile: `${log}.profile.json` });
  writeFileSync(log, output);
  if (isGreen && before !== null && committedTree(root) === before) writeFileSync(gitPath(root, STAMP), `${before}\n`);
  return { isGreen, isCached: false, output, seconds, log, profile, profilePath };
}

/** Quote a fixed executable or selected path without permitting shell expansion. */
function commandWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Prove the frozen item check and selected imports under one lease. Subsets neither read nor write
 * the full-gate stamp. An uncertain selection runs the full configured gate and records its reason.
 *
 * @param {string} root
 * @param {any} config
 * @param {{base:string|null, trunk?:string, changed?:string[], check:string, onWait?:(state:object)=>void}} options
 * @returns {Promise<any>}
 */
export async function runSubmitGate(root, config, { base, trunk, changed, check, onWait }) {
  if (!config.gate.trim()) throw new Refused('NO_GATE', 'no gate configured; set "gate" in pullboard.json, e.g. "npm test"');
  const selection = selectAffectedTests(root, { base, trunk, changed });
  return await withGateSlot(root, (lease) => {
    const startedAt = Date.now();
    const log = gitPath(root, 'pullboard-submit.log');
    const checkLog = `${log}.check.log`;
    const proofLog = `${log}.proof.log`;
    const criterion = check ? runProfiledShell(root, check, {
      waitMs: lease.waitMs, profileFile: `${checkLog}.profile.json`,
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
      });
      return { ...proof, log, seconds: criterion.seconds + proof.seconds, ...selection, check: receipt,
        profile, profilePath, proofProfilePath: proof.profilePath, proofLog: proof.log };
    };
    if (!criterion.isGreen) {
      writeFileSync(log, criterion.output);
      return finish({ isGreen: false, isCached: false, output: criterion.output, seconds: 0, log: '' });
    }
    // The proof already owns this lease: its phase profile has no additional queue wait.
    const proofWait = check ? 0 : lease.waitMs;
    let proof;
    if (selection.full) proof = fullGateRun(root, config, false, { waitMs: proofWait, log: proofLog });
    else if (!selection.files.length) proof = { isGreen: true, output: '', seconds: 0, isCached: false, log: '' };
    else {
      const runner = existsSync(join(root, 'bin/run-tests.js')) ? [process.execPath, 'bin/run-tests.js'] : [process.execPath, '--test'];
      const command = [...runner, ...selection.files.map(path => './' + path)].map(commandWord).join(' ');
      proof = { ...runProfiledShell(root, command, { waitMs: proofWait, profileFile: `${proofLog}.profile.json` }), isCached: false, log: proofLog };
      writeFileSync(proofLog, proof.output);
    }
    writeFileSync(log, `item check:\n${criterion.output}\n${selection.full ? 'full gate' : 'affected tests'}:\n${proof.output}`);
    return finish(proof);
  }, { onWait });
}

/** Describe precisely which submission proof ran, including absent checks and full fallbacks. */
export function submitGateReport(gate) {
  const check = gate.check.checked ? `item check ${gate.check.green ? 'green' : 'red'} in ${gate.check.seconds}s` : 'no item check';
  const selection = gate.full ? `full gate: ${gate.reason}` : `affected tests: ${gate.files.length ? gate.files.join(', ') : 'none'}`;
  const timings = timingDigest(gate.profile);
  const detail = timings ? `\n${timings}\ntiming profile: ${gate.profilePath}` : '';
  const result = gate.isGreen && !gate.full ? `affected tests green in ${gate.seconds}s${detail}` : gateReport(gate);
  return `${check}; ${selection}; ${result}`;
}

/** Show the ten slowest files, preserving actual Node timings rather than parsing TAP titles.
 * @param {{ files?: Array<{path: string, durationMs: number}> }|null} profile
 * @returns {string}
 */
export function timingDigest(profile) {
  if (!profile?.files?.length) return '';
  const rows = [...profile.files].filter(file => typeof file.path === 'string' && Number.isFinite(file.durationMs) && file.durationMs >= 0).sort((left, right) => right.durationMs - left.durationMs).slice(0, 10);
  return `slowest test files:\n${rows.map(file => `  ${file.path}: ${(file.durationMs / 1000).toFixed(2)}s`).join('\n')}`;
}

/**
 * What an agent sees of a gate run (V10): one line when green; when red, the digest and where the
 * whole output is.
 *
 * @param {{ isGreen: boolean, isCached: boolean, output: string, seconds: number, log: string, profile?: object, profilePath?: string }} gate
 * @returns {string}
 */
export function gateReport(gate) {
  const timings = timingDigest(gate.profile);
  const profilePath = timings && gate.profilePath ? `\ntiming profile: ${gate.profilePath}` : '';
  if (gate.isGreen) {
    const summary = gate.isCached ? 'gate green (this tree already passed)' : `gate green in ${gate.seconds}s`;
    return timings ? `${summary}\n${timings}${profilePath}` : summary;
  }
  return `gate red in ${gate.seconds}s:\n${digestOf(gate.output).replace(/^/gm, '  ')}\n${timings ? `${timings}\n` : ''}the whole output is in ${gate.log}${profilePath}`;
}
