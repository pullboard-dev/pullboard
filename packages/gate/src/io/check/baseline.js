import {
  timingFromOutput,
  timingRunner,
} from '../timing.js';
export { provingCheck, sayCheckBaseline } from '../../logic/format.js';
/** Observe a proposed check on an isolated copy of main before recording its move [V2,H16]. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import {
  gitChildEnv,
  mainCheckout,
  tryGit,
} from '../../../../git/index.js';
import { runShell } from '../run/shell.js';
import { mappedCheck } from '../../../../codemap/index.js';
import { Refused } from '../../../../kernel/index.js';
import { secretsIn } from '../../../../commits/index.js';

/** The local branch the baseline's temporary copy of main is checked out on. */
const BASELINE_BRANCH = 'pullboard-check-baseline';

/**
 * Capture the command and coordinator commit once on the sender; replay only receives this observation.
 * A detached coordinator checkout cannot turn an unavailable baseline into a new gate.
 *
 * @param {string} root
 * @param {string} command
 * @param {{main?: string}} [options]
 * @returns {{command: string, main: string|null, result: string, reason?: string, seconds?: number}}
 */
export function checkBaseline(root, command, { main = undefined } = {}) {
  const captured = main === undefined ? prepareCheckBaseline(root, command) : { command, main, result: 'pending' };
  if (captured.result !== 'pending') return captured;
  const base = { command, main: captured.main };
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-check-base-'));
  const checkout = join(directory, 'checkout');
  const env = gitChildEnv(root);
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // A branch, not a detached HEAD: the copy is main, and a check that reads accepted main (run-tests.js reads test
    // file budgets against it) finds it here. Detached, every such baseline went red in about a second (#2463).
    const selected = clone.status === 0 && spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '-b', BASELINE_BRANCH, base.main], { cwd: checkout, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!selected || selected.status !== 0) return { ...base, result: 'unavailable', reason: 'temporary checkout could not be prepared' };
    const ran = runShell(checkout, mappedCheck(checkout, command));
    const failures = baselineFailureDetails(ran.output);
    return { ...base, result: ran.isGreen ? 'green' : 'red', seconds: ran.seconds,
      ...(failures.length ? { reason: failures.map(row => `${row.name}: ${row.error}`).join('\n') } : !ran.isGreen && outputTail(ran.output) ? { reason: outputTail(ran.output) } : {}),
      testEvidence: baselineTestEvidence(ran.output, command, checkout) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The last lines of a red check that named no failing case, bounded and scrubbed, or '' when it printed nothing.
 * Why: a red baseline with no TAP failure kept no reason at all, so nobody could tell why main was red (#2463).
 */
function outputTail(output) {
  const lines = String(output ?? '').split(/\r?\n/u).map(line => line.trimEnd()).filter(Boolean).slice(-12)
    .map(line => line.slice(0, 512));
  const text = lines.join('\n').slice(-1024);
  return text && secretsIn([{ path: 'check output', line: 1, text }]).length ? '[redacted output]' : text;
}

/** The captured check as a runner runs it at the captured main, with moved paths mapped as of that commit [C7,#2520]. */
export function runnerBaselineCommand(root, expected) {
  return mappedCheck(root, expected.command, { commit: expected.main });
}

/**
 * The baseline a runner's run of the check at the captured main records: green on exit 0, otherwise red with its first
 * failure lines and observed cases, in the same shape a local temporary-clone run records [C7,#2520].
 *
 * @param {{ command: string, main: string }} expected - The captured request.
 * @param {{ exitCode?: number|null, output?: string, executionRoot?: string }} run - The runner's result.
 * @param {number} seconds - Wall time of the run.
 */
export function runnerBaseline(expected, run, seconds) {
  const output = String(run?.output ?? '');
  const failures = baselineFailureDetails(output);
  return { command: expected.command, main: expected.main, result: run?.exitCode === 0 ? 'green' : 'red',
    seconds: Math.max(0, Math.round(seconds)),
    ...(failures.length ? { reason: failures.map(row => `${row.name}: ${row.error}`).join('\n') } : {}),
    testEvidence: baselineTestEvidence(output, expected.command, run?.executionRoot ?? null) };
}

/** Decode only XML's built-in and numeric entities in one JUnit attribute or text. */
function xmlText(value) {
  return value.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|(amp|lt|gt|quot|apos));/giu, (whole, number, named) => {
    if (number) {
      const point = Number.parseInt(number.startsWith('x') ? number.slice(1) : number, number.startsWith('x') ? 16 : 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : whole;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named.toLowerCase()];
  });
}

/** Read JUnit case names and their first failure message without loading external XML entities. */
function junitFailures(output) {
  const rows = [], tags = /<\s*(\/?)(?:[\w.-]+:)?(testcase|failure|error)\b([^<>]*?)(\/?)>/giu;
  let current = null, tag;
  while ((tag = tags.exec(output)) && rows.length < 512) {
    const closing = Boolean(tag[1]), kind = tag[2].toLowerCase();
    const attrs = Object.fromEntries([...tag[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)].map(match => [match[1], xmlText(match[2] ?? match[3])]));
    if (kind === 'testcase') { current = closing || tag[4] ? null : { name: attrs.name ?? '' }; continue; }
    if (!closing && current?.name && !current.error) {
      const body = output.slice(tags.lastIndex, output.indexOf('<', tags.lastIndex) < 0 ? output.length : output.indexOf('<', tags.lastIndex));
      current.error = (attrs.message ?? xmlText(body)).split(/\r?\n/u).find(line => line.trim())?.trim() ?? '';
      if (current.error) rows.push({ name: current.name, error: current.error });
    }
  }
  return rows;
}

/** Keep each TAP failure's first diagnostic line, bounded and scrubbed before it reaches the board. */
export function baselineFailureDetails(output) {
  const rows = [], stack = [];
  for (const raw of String(output ?? '').split(/\r?\n/u)) {
    if (Buffer.byteLength(raw, 'utf8') > 65536) continue;
    const indent = raw.length - raw.trimStart().length, text = raw.trim();
    const match = /^(not ok|ok)\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/u.exec(text);
    if (match) {
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      if (match[1] === 'not ok') { const row = { name: match[2].slice(0, 4096), error: '', indent, block: false }; rows.push(row); stack.push(row); }
      continue;
    }
    const row = stack.at(-1);
    if (!row || indent <= row.indent || row.error) continue;
    const error = /^error:\s*(.*)$/u.exec(text);
    if (error) { row.block = /^(?:[|>][-+]?|)$/.test(error[1]); if (!row.block) row.error = error[1].replace(/^['"]|['"]$/gu, ''); }
    else if (row.block && text && text !== '...') row.error = text;
  }
  return [...rows.filter(row => row.error), ...junitFailures(String(output ?? ''))].slice(0, 512).map(({ name, error }) => ({
    name: secretsIn([{ path: 'check output', line: 1, text: name.slice(0, 65536) }]).length ? '[redacted test name]' : name.slice(0, 4096),
    error: secretsIn([{ path: 'check output', line: 1, text: error.slice(0, 65536) }]).length ? '[redacted error]' : error.slice(0, 1024),
  }));
}

/** Retain observed case outcomes, distinguishing an absent named case from unrelated shell failure. */
export function baselineTestEvidence(output, command, root = null) {
  const tests = timingFromOutput(output, timingRunner(command)).tests;
  // Each failing case keeps the repository file it ran in, so a case is matched by file and name, never name alone (#2594).
  const relative = file => {
    if (typeof file !== 'string' || !file) return null;
    for (const base of root ? [root, realOrSame(root)] : []) if (file.startsWith(base + '/')) return file.slice(base.length + 1);
    return isAbsolute(file) ? null : file.replace(/^\.\//u, '');
  };
  const failedCases = [...new Map(tests.filter(test => !test.passed).map(test => ({ file: relative(test.file), name: test.name }))
    .filter(row => row.file).map(row => [`${row.file}\0${row.name}`, row])).values()].slice(0, 512);
  return { failed: [...new Set(tests.filter(test => !test.passed).map(test => test.name))].slice(0,512),
    passed: [...new Set(tests.filter(test => test.passed).map(test => test.name))].slice(0,512),
    failedCases,
    noTestsMatched: /^run-tests: NO_TESTS_MATCHED:/mu.test(output) };
}

/** A directory's real path, or the path itself when it cannot be resolved. */
function realOrSame(path) {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Refuse a check the shell cannot parse, quoting the shell's own message. sh -n reads the command
 * without running it, so a stray quote is caught when the check is set instead of surfacing later
 * as a baseline red that looks like a test failing before the work [C7,V4].
 *
 * @param {string} command
 */
export function refuseCheckSyntax(command) {
  // /bin/sh is the shell checks run in (spawn's shell: true); a parse that cannot start is no verdict.
  const parsed = spawnSync('/bin/sh', ['-n', '-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  if (parsed.status === 0 || parsed.error || parsed.status === null) return;
  const said = `${parsed.stderr ?? ''}`.trim().split('\n').map((line) => line.trim()).filter(Boolean).join('; ') || `sh -n exited ${parsed.status}`;
  throw new Refused('CHECK_SYNTAX', `the check is not valid shell, so it would only ever run red: ${said}`);
}

/** Capture the authorized check's immutable base without running its shell command [V2,H16]. */
export function prepareCheckBaseline(root, command) {
  const primary = mainCheckout(root);
  if (!primary) return { command, main: null, result: 'unavailable', reason: 'coordinator checkout is detached' };
  if (!primary.commit) return { command, main: null, result: 'unavailable', reason: 'no main' };
  const base = { command, main: primary.commit };
  return { ...base, result: 'pending', request: randomUUID() };
}
