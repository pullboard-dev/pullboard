/** A red gate names only what failed: each failing case with its first error line, plus any runner error [C7]. */
import { fileSystemAdapter } from '../../../fs/index.js';
import { renderTestSummary } from './test/summary.js';
import { testTierReport } from './test/tier/selection.js';

const fs = fileSystemAdapter();

const RUNNER_ERROR_LIMIT = 3;
const TEXT_LIMIT = 240;

/**
 * The test files a summary's failing cases came from, in first-seen order. A file-level failure (a module that
 * throws on import) has no case title, so its row's name is the file path itself.
 * @param {{failures?:object[]}} summary
 * @returns {string[]}
 */
function failingFiles(summary) {
  const files = (summary?.failures ?? []).map(row => row.file || (/\.test\.[cm]?js$/u.test(row.name ?? '') ? row.name : null));
  return [...new Set(files.filter(Boolean))];
}

/**
 * Say how much ran and name only the files that failed. A red refusal lists failures; the files that passed only
 * bury them, so every shape of gate (tiered, deferred, full or affected) counts the rest and leaves them to the log.
 * @param {object} gate
 * @param {{failures?:object[]}} [summary]
 * @returns {string}
 */
export function redGateScope(gate, summary) {
  if (gate.testTiers) return testTierReport(gate.testTiers, { names: false });
  const failing = failingFiles(summary).filter(file => (gate.files ?? []).some(selected => file === selected || file.endsWith('/' + selected)));
  const ran = `${gate.files?.length ?? 0} ran${failing.length ? `, failing: ${failing.join(', ')}` : ''}; the failing cases follow, the rest are in the full log`;
  if (gate.deferred) return `affected tests: ${ran}; full suite deferred to the landing gate`;
  if (gate.full) return `full gate: ${gate.reason}`;
  return `affected tests: ${ran}`;
}

/**
 * Lines the test runner itself wrote about a failure outside any test case, such as a hung file or a temporary
 * folder it could not remove. Those are why a run went red when every listed case passed, so they are kept.
 * @param {string|undefined} logPath
 * @returns {string[]}
 */
export function runnerErrors(logPath) {
  let output = '';
  try { output = logPath ? fs.readFile(logPath, 'utf8') : ''; } catch { return []; }
  const lines = output.split('\n')
    .map(line => line.replace(/\x1b\[[0-9;]*m/gu, '').trim())
    .filter(line => /^#?\s*run-tests:/u.test(line))
    .map(line => line.replace(/^#\s*/u, ''))
    .map(line => line.length > TEXT_LIMIT ? line.slice(0, TEXT_LIMIT - 1) + '…' : line);
  return [...new Set(lines)].slice(0, RUNNER_ERROR_LIMIT);
}

/**
 * The body of a red gate refusal: the item check's state, a count of what ran, any extra sections the caller
 * already reports (registry guards, quarantine verdicts, cross-lane edits), each failing case with its first
 * error line, any runner error, and the full log's path. It never lists a file that passed.
 * @param {object} gate
 * @param {{counts:object,failures:object[],logPath:string}} summary
 * @param {{ registry?: string, sections?: string[] }} [extra]
 * @returns {string}
 */
export function redGateReport(gate, summary, { registry = '', sections = [] } = {}) {
  const check = gate.check?.checked ? `item check ${gate.check.green ? 'green' : 'red'}` : 'no item check';
  const known = new Set(summary.diagnostics ?? []);
  const runner = runnerErrors(summary.logPath).filter(line => !known.has(line));
  return [`${check}${registry}; ${redGateScope(gate, summary)}`, ...sections.filter(Boolean), renderTestSummary(summary), ...runner]
    .join('\n');
}
