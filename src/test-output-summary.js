/** Test presentation reads full native logs; compact words never become proof [C7,V10]. */
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gitPath } from './git.js';
import { safeLog } from './gate-execution.js';
import { tapTests } from './tap-tests.js';

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
 * @param {{ root?: string, profile?: object }} [options]
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
  const failed = rows.flatMap((row, index) => row.passed || row.skip ? [] : [{
    file: short(row.file ?? profile?.testOutcomes?.find(test => test.name === row.name)?.file) || null,
    name: short(row.name), error: short(errors[index] || row.failureType || 'no error line recorded'),
  }]);
  const unstructured = !rows.length || rows.some((row, index) => !row.passed && !row.skip && (!errors[index] || /^test failed$/iu.test(errors[index])));
  const lines = output.split('\n').filter(line => line.trim());
  const detail = unstructured ? lines.filter(line => !/^\s*(?:item check:|affected tests:|full gate:|proof:|TAP version |# (?:Subtest:|tests |suites |pass |fail |cancelled |skipped |todo |duration_ms |pullboard )|(?:not )?ok \d+|\d+\.\.\d+|---|\.\.\.)/u.test(line)) : [];
  const diagnostics = [...new Set([detail[0], ...detail.filter(line => /ERR_[A-Z_]+|(?:Assertion)?Error[: [|]/u.test(line))]
    .filter(Boolean))].slice(0, 3).map(short);
  if (!rows.length && output.trim()) failed.push({ file: null, name: 'command output',
    error: short(diagnostics[0] ?? lines[0]) });
  return { counts, failures: failed.slice(0, FAILURE_LIMIT),
    ...(diagnostics.length ? { diagnostics: rows.length ? diagnostics : diagnostics.slice(1), omittedOutputLines: Math.max(0, lines.length - diagnostics.length) } : {}),
    omittedFailures: Math.max(0, failed.length - FAILURE_LIMIT), logPath };
}

/**
 * Retain the complete sanitized output in this run's own directory before returning its presentation.
 * @param {string} root
 * @param {string} output
 * @param {{ root?: string, profile?: object }} [options]
 */
export function retainTestOutput(root, output, options = {}) {
  const directory = gitPath(root, join('pullboard-runs', randomUUID()));
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
  return [heading, ...failures,
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
