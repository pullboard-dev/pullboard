/**
 * The pure half of the clause runner: what each bar clause asks, whether its paths and command are allowed, and what a
 * test run's reporter events prove [CR3].
 *
 * Every input here is untrusted record text. Nothing in this file reads the disk or starts a process; the shell half
 * (../io/contribution-clauses.js) runs the commands and hands the results back here to judge.
 */
import { Refused } from '../../../kernel/index.js';

/** The clause kinds of CR3, as a bar line names them in its trailing brackets. */
export const CLAUSE_KINDS = Object.freeze(['test', 'test, kept', 'command', 'measurement']);

/** Folder names whose files count as a PR's test-directory changes: the test, its helpers and its fixtures. */
export const DEFAULT_TEST_DIRS = Object.freeze(['test', 'tests', '__tests__', 'fixtures']);

/** What every gate output says about CR3's limit, so no one reads a proven clause as a meaningful one. */
export const CLAUSE_LIMIT_NOTE = 'CR3 proves a test is bound to the change, not that it means what the clause says; a maintainer judges meaning at acceptance.';

/** Characters a shell would read as syntax; a check command holding one is refused rather than guessed at. */
const SHELL_SYNTAX = /[;&|`$<>(){}[\]*?!~\\'"#\n\r]/u;

/** A URL scheme at the start of a word (file:, data:, node:, https:): a loader would fetch it from outside the repository. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/u;

/** The leading clause number of a bar or check entry, and the rest of the line. */
function numbered(line) {
  const match = String(line).match(/^(\d+):\s+(.*)$/su);
  return match ? { n: match[1], rest: match[2].trim() } : null;
}

/**
 * Pair each bar clause with its check and read the clause kind from its trailing brackets.
 * Why: the record parser already proved every clause has a numbered check; this names what the gate must run [CR3].
 *
 * @param {string[]} bar - Bar entries, `n: clause [kind]`.
 * @param {string[]} check - Check entries, `n: command`.
 * @returns {{ n: string, clause: string, kind: string | null, check: string }[]}
 */
export function pairClauses(bar, check) {
  const checks = new Map();
  for (const line of check ?? []) {
    const entry = numbered(line);
    if (entry) checks.set(entry.n, entry.rest);
  }
  return (bar ?? []).map(line => {
    const entry = numbered(line);
    if (!entry) throw new Refused('CLAUSE_NUMBER', `bar entry "${String(line).slice(0, 40)}" does not start with "n: "`, 'write each clause as "1: what must hold [kind]"');
    const kindMatch = entry.rest.match(/\[([^\]]+)\]\s*$/u);
    const kind = kindMatch ? kindMatch[1].trim().replace(/\s*,\s*/gu, ', ') : null;
    return { n: entry.n, clause: entry.rest, kind, check: checks.get(entry.n) ?? '' };
  });
}

/**
 * The reason a check of `none` gives, or null when the check is something to run.
 * A bare `none` is refused: an unverifiable clause must say why, so a maintainer can decide [CR3].
 *
 * @param {string} check
 * @returns {string | null}
 */
export function noneReason(check) {
  const match = String(check).match(/^none\b\s*[:+,-]?\s*(.*)$/isu);
  if (!match) return null;
  if (!match[1].trim()) throw new Refused('CLAUSE_NONE_REASON', 'a check of none gives no reason', 'write "none: <why the gate cannot run it here>", for example "none: Windows-only proof"');
  return match[1].trim();
}

/**
 * Refuse a path the record names unless it stays inside the repository by its words: relative, no `..` segment, no
 * home or drive prefix. The shell half also resolves symlinks before it trusts the path [CR3].
 *
 * @param {string} path
 * @param {string} where - What named the path, for the refusal.
 * @returns {string} The path with any leading ./ removed.
 */
export function insideRepoPath(path, where) {
  const text = String(path).trim();
  const refuse = rule => new Refused('CLAUSE_PATH', `${where}: "${text.slice(0, 80)}" ${rule}`, 'name a file by its path inside the repository, with no leading / and no .. segment');
  if (!text) throw refuse('is empty');
  if (text.includes('\0')) throw refuse('holds a null byte');
  if (text.startsWith('-')) throw refuse('starts with "-", which a command would read as an option');
  if (/^[/\\~]/u.test(text) || /^[A-Za-z]:/u.test(text)) throw refuse('is outside the repository: absolute paths are refused');
  if (URL_SCHEME.test(text)) throw refuse('is outside the repository: a URL such as file: or data: is refused');
  if (text.split(/[/\\]/u).includes('..')) throw refuse('is outside the repository: ".." segments are refused');
  return text.replace(/^(\.\/)+/u, '');
}

/**
 * Split a `[test]` check, `<test file in repo> > <test name>`, into its file and test name.
 *
 * @param {string} check
 * @returns {{ file: string, name: string }}
 */
export function parseTestCheck(check) {
  const at = String(check).indexOf(' > ');
  if (at < 0) throw new Refused('CLAUSE_TEST_CHECK', `test check "${String(check).slice(0, 80)}" does not name a file and a test`, 'write the check as "<test file in repo> > <test name>"');
  const name = check.slice(at + 3).trim();
  if (!name) throw new Refused('CLAUSE_TEST_CHECK', 'the test check names no test', 'write the test name after " > "');
  return { file: insideRepoPath(check.slice(0, at), 'test file'), name };
}

/**
 * Match a command against the allowlist and return its words, refusing anything not on it.
 * Why: a check command is contributor text; only a command the maintainers listed may run, and it runs without a shell,
 * so its words are the words on the list plus repository paths [CR3,CR8].
 *
 * @param {string} command - The check text.
 * @param {string[]} allowlist - Allowed command prefixes as data, such as "node bin/run-tests.js".
 * @returns {string[]} The command's words.
 */
export function allowlistedCommand(command, allowlist) {
  const text = String(command).trim();
  const next = 'use a command the repository allowlists, with plain words and repository paths only';
  if (!text) throw new Refused('CLAUSE_COMMAND_EMPTY', 'the check command is empty', next);
  if (SHELL_SYNTAX.test(text)) throw new Refused('CLAUSE_COMMAND_SYNTAX', `"${text.slice(0, 80)}" holds shell syntax; checks run without a shell`, next);
  const words = text.split(/\s+/u);
  const allowed = (allowlist ?? []).some(entry => {
    const prefix = String(entry).trim().split(/\s+/u);
    return prefix.length > 0 && prefix[0] !== '' && prefix.every((word, i) => words[i] === word);
  });
  if (!allowed) throw new Refused('CLAUSE_NOT_ALLOWLISTED', `"${text.slice(0, 80)}" is not on the command allowlist`, next);
  for (const word of words.slice(1)) {
    if (word.startsWith('-')) {
      const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : '';
      if (/[/\\]/u.test(value) || value.startsWith('~') || URL_SCHEME.test(value)) insideRepoPath(value, 'command argument');
      continue;
    }
    if (/[/\\]/u.test(word) || word.startsWith('~') || word === '..' || URL_SCHEME.test(word)) insideRepoPath(word, 'command argument');
  }
  return words;
}

/**
 * The threshold a `[measurement]` clause states, such as "under 100 ms" or "at most 3".
 *
 * @param {string} clause
 * @returns {{ op: '<' | '<=' | '>' | '>=', value: number }}
 */
export function measurementThreshold(clause) {
  const words = [
    ['<=', /(?:<=|≤|at most|no more than)\s*(-?\d+(?:\.\d+)?)/iu],
    ['>=', /(?:>=|≥|at least|no less than)\s*(-?\d+(?:\.\d+)?)/iu],
    ['<', /(?:<|under|below|less than)\s*(-?\d+(?:\.\d+)?)/iu],
    ['>', /(?:>|over|above|more than)\s*(-?\d+(?:\.\d+)?)/iu],
  ];
  for (const [op, pattern] of words) {
    const match = String(clause).match(pattern);
    if (match) return { op, value: Number(match[1]) };
  }
  throw new Refused('CLAUSE_THRESHOLD', `measurement clause "${String(clause).slice(0, 80)}" states no threshold`, 'state the threshold in the clause, such as "under 100 ms" or "at most 3"');
}

/**
 * Judge one measurement: the command printed exactly one number and it meets the threshold.
 *
 * @param {string} stdout
 * @param {{ op: string, value: number }} threshold
 * @returns {{ ok: boolean, value: number | null, reason: string }}
 */
export function judgeMeasurement(stdout, threshold) {
  const text = String(stdout).trim();
  if (!/^-?\d+(?:\.\d+)?$/u.test(text)) return { ok: false, value: null, reason: `the check must print one number; it printed "${text.slice(0, 60)}"` };
  const value = Number(text);
  const ok = { '<': value < threshold.value, '<=': value <= threshold.value, '>': value > threshold.value, '>=': value >= threshold.value }[threshold.op];
  return { ok, value, reason: `measured ${value} on head; the clause needs ${threshold.op} ${threshold.value}` };
}

/**
 * What one named test did, read from the gate's own reporter events and the process result.
 * Why: the verdict comes from the gate's reporter, never the test's own output, and a failure counts only when an
 * assertion fails; a load error, a non-assertion throw and a run of zero tests are each named apart [CR3].
 *
 * @param {{ type: string, name?: string, nesting?: number, skip?: boolean, todo?: boolean, failureType?: string, causeCode?: string }[]} events
 * @param {string} name - The test the check names.
 * @param {{ status: number | null, signal?: string | null, timedOut?: boolean }} exit
 * @returns {'assertion' | 'error' | 'pass' | 'load-error' | 'zero-tests' | 'timeout'}
 */
export function testOutcome(events, name, exit) {
  if (exit.timedOut || exit.signal) return 'timeout';
  const index = events.findIndex(event => (event.type === 'test:pass' || event.type === 'test:fail') && event.nesting === 0 && event.name === name && !event.skip && !event.todo);
  if (index < 0) return exit.status === 0 ? 'zero-tests' : 'load-error';
  const event = events[index];
  if (event.type === 'test:pass') return 'pass';
  if (event.causeCode === 'ERR_ASSERTION') return 'assertion';
  if (event.failureType === 'subtestsFailed') {
    // A parent fails when a subtest does; it fails on an assertion only if a subtest above it in the stream did.
    let i = index - 1;
    while (i >= 0 && (events[i].nesting ?? 0) > 0) {
      if (events[i].type === 'test:fail' && events[i].causeCode === 'ERR_ASSERTION') return 'assertion';
      i--;
    }
  }
  return 'error';
}

/** Why each outcome other than an assertion failure does not prove a `[test]` clause on base source. */
const NOT_BOUND = Object.freeze({
  pass: 'passes on base source, so it does not prove the change (an assert-true test)',
  error: 'fails on base source with an error that is not an assertion',
  'load-error': 'does not load on base source; a missing helper, import or symbol does not count',
  'zero-tests': 'ran zero tests on base source; the named test does not exist there',
  timeout: 'timed out on base source',
});

/**
 * The verdict of a `[test]` clause: head's test must fail on an assertion against base source, then pass on head.
 *
 * @param {string} onBase - testOutcome on base source plus the PR's test-directory changes.
 * @param {string | null} onHead - testOutcome on head, or null when base already disqualified it.
 * @param {string} name
 * @returns {{ verdict: 'proven' | 'failed', reason: string }}
 */
export function judgeTest(onBase, onHead, name) {
  if (onBase !== 'assertion') return { verdict: 'failed', reason: `"${name}" ${NOT_BOUND[onBase] ?? `ended as ${onBase} on base source`}` };
  if (onHead !== 'pass') return { verdict: 'failed', reason: `"${name}" fails on an assertion against base source but does not pass on head (${onHead})` };
  return { verdict: 'proven', reason: `"${name}" fails on an assertion against base source and passes on head` };
}

/**
 * The verdict of a `[test, kept]` clause: base's test passes on head source.
 *
 * @param {string} onHead
 * @param {string} name
 * @returns {{ verdict: 'proven' | 'failed', reason: string }}
 */
export function judgeKeptTest(onHead, name) {
  if (onHead === 'pass') return { verdict: 'proven', reason: `base's "${name}" passes on head source` };
  return { verdict: 'failed', reason: `base's "${name}" does not pass on head source (${onHead})` };
}

/**
 * The verdict of a `[command]` clause: the exit code changes from failing on base to passing on head.
 *
 * @param {number | null} baseStatus
 * @param {number | null} headStatus
 * @returns {{ verdict: 'proven' | 'failed', reason: string }}
 */
export function judgeCommand(baseStatus, headStatus) {
  if (headStatus === 0 && baseStatus !== 0) return { verdict: 'proven', reason: `exits ${baseStatus} on base and 0 on head` };
  if (headStatus !== 0) return { verdict: 'failed', reason: `exits ${headStatus} on head; it must exit 0` };
  return { verdict: 'failed', reason: 'exits 0 on base too, so the exit code does not change with the change' };
}

/**
 * Whether a repository path sits in a test directory, by any of its folder names.
 *
 * @param {string} path
 * @param {readonly string[]} [testDirs]
 * @returns {boolean}
 */
export function inTestDirectory(path, testDirs = DEFAULT_TEST_DIRS) {
  return String(path).split('/').slice(0, -1).some(part => testDirs.includes(part));
}

/** Escape a test name for node's --test-name-pattern, anchored so only that exact name runs. */
export function exactNamePattern(name) {
  return `^${String(name).replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}$`;
}
