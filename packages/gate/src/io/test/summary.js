/** Test presentation reads full native logs; compact words never become proof [C7,V10]. */
import { testOutcomeFields } from './outcomes.js';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { boardFolderFile } from '../../../../git/index.js';
import { safeLog } from '../execution.js';
import { tapTests } from '../tap.js';
import { readCacheRows } from './account.js';
import { ledgerFromOutput } from './account.js';

const FAILURE_LIMIT = 30;
const TEXT_LIMIT = 240;

/** Keep reporter-controlled values on one bounded display line, retaining the full value in the log. */
function short(text) {
  const line = String(text ?? '').replace(/\x1b\[[0-9;]*m/gu, '').replace(/[\r\n\t]/gu, ' ').trim();
  return line.length > TEXT_LIMIT ? line.slice(0, TEXT_LIMIT - 1) + '…' : line;
}

/** Remove only a TAP scalar's surrounding quotes, not its diagnostic contents. */
function scalar(text) {
  return text.replace(/^(['"])(.*)\1$/u, '$2');
}

/**
 * Read reported counts and the first diagnostic of each failed case without granting execution authority.
 * Unsupported output keeps counts unknown; the full native log remains the source for proof parsing.
 * @param {string} logPath
 * @param {{ root?: string, profile?: object, directory?: string }} [options]
 * @returns {{counts:object,failures:object[],omittedFailures:number,logPath:string}}
 */
export function testOutputSummary(logPath, { root = process.cwd(), profile } = {}) {
  const output = readFileSync(logPath, 'utf8');
  const rows = tapTests(output, root);
  const counts = { passed: null, failed: null, skipped: null };
  const names = { pass: 'passed', fail: 'failed', skipped: 'skipped' };
  const errors = [];
  let current = -1;
  let multiline = false;
  for (const line of output.split('\n')) {
    const count = /^# (pass|fail|skipped) (\d+)\s*$/u.exec(line);
    if (count) counts[names[count[1]]] = (counts[names[count[1]]] ?? 0) + Number(count[2]);
    if (/^\s*(?:not ok|ok)\s+\d+\s+-\s+/u.test(line)) { current++; multiline = false; continue; }
    if (current < 0 || rows[current]?.passed || errors[current]) continue;
    const error = /^\s+error:\s*(.*)$/u.exec(line);
    if (error) {
      multiline = /^[|>][-+]?$/u.test(error[1]);
      if (!multiline) errors[current] = scalar(error[1]);
    } else if (multiline && line.trim()) { errors[current] = scalar(line.trim()); multiline = false; }
  }
  const outcomes = testOutcomeFields(profile?.testOutcomes) ?? [];
  const failedTitles = new Map();
  for (const row of rows) {
    if (!row.passed && !row.skip) failedTitles.set(row.name, (failedTitles.get(row.name) ?? 0) + 1);
  }
  /** A remote location may use a unique failed source identity, never the first of several title matches. */
  function outcomeFile(name) {
    if (failedTitles.get(name) !== 1) return null;
    const matches = outcomes.filter(test => test.name === name);
    return matches.length === 1 && !matches[0].passed && !matches[0].skipped ? matches[0].file : null;
  }
  const failed = rows.flatMap((row, index) => row.passed || row.skip ? [] : [{
    file: short(row.file ?? outcomeFile(row.name)) || null,
    name: short(row.name), error: short(errors[index] || row.failureType || 'no error line recorded'),
  }]);
  const unstructured = !rows.length || rows.some((row, index) => !row.passed && !row.skip && (!errors[index] || /^test failed$/iu.test(errors[index])));
  const lines = output.split('\n').filter(line => line.trim());
  const detail = unstructured ? lines.filter(line => !/^\s*(?:item check:|affected tests:|full gate:|proof:|TAP version |# (?:Subtest:|tests |suites |pass |fail |cancelled |skipped |todo |duration_ms |pullboard )|(?:not )?ok \d+|\d+\.\.\d+|---|\.\.\.)/u.test(line)) : [];
  const diagnostics = [...new Set([detail[0], ...detail.filter(line => /ERR_[A-Z_]+|(?:Assertion)?Error[: [|]/u.test(line))]
    .filter(Boolean))].slice(0, 3).map(short);
  if (!rows.length && output.trim()) failed.push({ file: null, name: 'command output',
    error: short(diagnostics[0] ?? lines[0]) });
  return { counts, cache: readCacheRows(output)?.summary ?? null, ledger: ledgerFromOutput(output), failures: failed.slice(0, FAILURE_LIMIT),
    ...(diagnostics.length ? { diagnostics: rows.length ? diagnostics : diagnostics.slice(1), omittedOutputLines: Math.max(0, lines.length - diagnostics.length) } : {}),
    omittedFailures: Math.max(0, failed.length - FAILURE_LIMIT), logPath };
}

/**
 * Retain the complete sanitized output in this run's own directory under the repository's common Git folder, so the run
 * outlives the worktree that made it and any worktree of the repo reads it by run id [C7,#10845].
 * @param {string} root
 * @param {string} output
 * @param {{ root?: string, profile?: object, directory?: string }} [options]
 */
export function retainTestOutput(root, output, options = {}) {
  const directory = options.directory ? join(options.directory, randomUUID()) : boardFolderFile(root, join('pullboard-runs', randomUUID()));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const logPath = join(directory, 'output.log');
  writeFileSync(logPath, safeLog(output), { flag: 'wx', mode: 0o600 });
  return testOutputSummary(logPath, options);
}

/** A fixed-size summary names each retained failure once and always points to the complete log. */
export function renderTestSummary(summary) {
  const { passed, failed, skipped } = summary.counts;
  const heading = passed === null || failed === null ? 'test counts unavailable'
    : `${passed} passed, ${failed} failed, ${skipped ?? 'unknown'} skipped`;
  const failures = summary.failures.map(row => `${short(row.file || '(file unavailable)')}: ${row.name}: ${row.error}`);
  return [heading, ...(summary.cache ? [summary.cache] : []), ...(summary.ledger ? [summary.ledger] : []), ...failures,
    ...(summary.diagnostics ?? []),
    ...(summary.omittedOutputLines ? [`${summary.omittedOutputLines} nonempty output lines omitted`] : []),
    ...(summary.omittedFailures ? [`${summary.omittedFailures} additional failures are in the full log`] : []),
    `full log: ${summary.logPath}`].join('\n');
}

/** Keep timing and source metadata public while detailed case records stay in the full profile file. */
export function summaryProfile(profile) {
  if (!profile) return profile;
  const { tests, testOutcomes, ...metadata } = profile;
  return metadata;
}

/** Attach presentation metadata without changing the refusal code, next step, or native outcome. */
export function withTestOutput(error, summary) {
  error.testOutput = summary;
  return error;
}

/** The most output lines shown for one failing case's expected or actual value. */
const ASSERTION_VALUE_LINES = 3;

/**
 * Read each failing case's assertion lines from a retained TAP log: file:line, error, expected and actual when present.
 * Why: builders could not see why a red gate failed once the log was gone, and could not run the tests themselves [C7,#3381].
 *
 * @param {string} log - Retained gate output.
 * @returns {string[]} Display lines, one group per failed case.
 */
export function failedAssertionLines(log) {
  const lines = String(log).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^not ok \d+ - (.*)$/u.exec(lines[i]);
    if (!head) continue;
    const fields = new Map();
    let key = null;
    for (i++; i < lines.length && !/^ {2}\.\.\.$/u.test(lines[i]) && !/^(?:not )?ok \d+ /u.test(lines[i]); i++) {
      const field = /^ {2}([A-Za-z_]+):\s?(.*)$/u.exec(lines[i]);
      if (field) { key = field[1]; fields.set(key, field[2] && !/^\|-?$/u.test(field[2]) ? [field[2]] : []); }
      else if (key && /^ {4}/u.test(lines[i])) fields.get(key).push(lines[i].trim());
    }
    if (fields.get('failureType')?.[0]?.includes('subtestsFailed')) continue;
    const location = (fields.get('location')?.[0] ?? '').replace(/^['"]|['"]$/gu, '').replace(/^.*\/checkout\//u, '').replace(/:\d+$/u, '');
    out.push(`${location || '(file unavailable)'}: ${short(head[1])}`);
    for (const name of ['error', 'expected', 'actual']) {
      const value = fields.get(name);
      if (value?.length) out.push(`  ${name}: ${value.slice(0, ASSERTION_VALUE_LINES).map(row => short(scalar(row))).join(' / ')}${value.length > ASSERTION_VALUE_LINES ? ' ...' : ''}`);
    }
  }
  return out;
}

/**
 * The assertion lines of a submit job's newest retained gate log, or an empty list when none was kept.
 *
 * @param {string} commonDir - The repository's git common directory.
 * @param {string} jobId - The submit-handoff job.
 * @returns {string[]} Display lines from failedAssertionLines.
 */
export function retainedGateAssertions(commonDir, jobId) {
  const output = join(commonDir, 'pullboard', 'submit-handoffs', jobId, 'output');
  let newest = null;
  try {
    for (const name of readdirSync(output)) {
      const file = join(output, name, 'output.log');
      try { const at = statSync(file).mtimeMs; if (!newest || at > newest.at) newest = { file, at }; } catch { /* no log in this run */ }
    }
    return newest ? failedAssertionLines(readFileSync(newest.file, 'utf8')) : [];
  } catch { return []; }
}
