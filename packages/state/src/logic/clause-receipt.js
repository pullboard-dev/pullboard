/** The fail-before, pass-after judge of a [test] clause's test (RFC 0009 CR3) and its receipt: judged from recorded runs, stored once on the item, printed by show [C7]. */
import { criterionClauses } from './clauses.js';
import { gateNamedFile } from './clauses.js';

const RECEIPT = /^receipt for clause (\d+): ([\s\S]+)$/u;
const NAMED_CASES = 3;

/** The [test] clauses that name a gate file, each with that file. */
function namedTestClauses(item, files) {
  return criterionClauses(item.item_criterion).flatMap(clause => {
    const file = gateNamedFile(clause, files, item);
    return file ? [{ clause, file }] : [];
  });
}

/** The distinct test files the [test] clauses name, which need a recorded base run for their fail-before receipt [C7]. */
export function clauseTestFiles(item, files) {
  return [...new Set(namedTestClauses(item, files).map(entry => entry.file))];
}

/**
 * A refusal when a [test] clause's named file has no recorded run that failed on an assertion at the item's base commit.
 * The head half is the gate's own run, which records the receipt once it passes, so only the base half can be judged
 * before submit. Why: a test that never failed at base is not bound to the change, so it can tick a clause no behaviour
 * backs; a load error, zero tests or a skip at base does not count as failing (RFC 0009 CR3) [C7].
 *
 * @param {object} item - The item row.
 * @param {{ gateFiles: Set<string>, baseRows: object[], baseCommit: string | null }} proof - Files the gate will run, the recorded outcome rows of runs at the base commit, and that commit.
 * @returns {{ message: string, next: string } | null} The refusal's words, for the caller to throw as CLAUSE_UNTICKED.
 */
export function clauseReceiptProblem(item, { gateFiles, baseRows, baseCommit }) {
  const problems = [];
  for (const { clause, file } of namedTestClauses(item, gateFiles)) {
    // The head is assumed to pass here: the gate proves it, and a red gate records no receipt.
    const assumed = (baseRows ?? []).filter(row => row.file === file).map(row => ({ ...row, passed: true, skipped: false }));
    const verdict = failBeforePassAfter(baseRows, assumed, file);
    if (!verdict.proven) problems.push(`clause ${clause.number} names ${file}, with no recorded run that fails on an assertion at base ${String(baseCommit).slice(0, 12)} (${verdict.reason})`);
  }
  return problems.length
    ? { message: `${problems.join('; ')}; a [test] clause needs a fail-before, pass-after receipt`,
      next: 'record a run of the named file at the base commit that fails on an assertion, then submit again' }
    : null;
}

/**
 * One receipt note per [test] clause whose named file failed on an assertion at base and passed at head, left off when
 * the thread already holds that clause's receipt for these commits (stored once). Why: the reviewer cites the receipt
 * instead of rerunning the test [C7].
 *
 * @param {object} item - The submitted item.
 * @param {object[]} thread - The item's thread.
 * @param {{ gateFiles: Set<string>, baseRows: object[], outcomes: object[], head: string, baseCommit: string | null }} run - Files the gate ran, recorded base rows, the gate's head rows and both commits.
 * @returns {string[]} Note texts for the item's thread.
 */
export function clauseReceiptNotes(item, thread, { gateFiles, baseRows, outcomes, head, baseCommit }) {
  const held = clauseReceipts(thread);
  const notes = [];
  for (const { clause, file } of namedTestClauses(item, gateFiles)) {
    const verdict = failBeforePassAfter(baseRows, outcomes, file);
    if (!verdict.proven) continue;
    const listed = verdict.cases.slice(0, NAMED_CASES).join('; ') + (verdict.cases.length > NAMED_CASES ? '; ...' : '');
    const text = `receipt for clause ${clause.number}: ${file} failed on an assertion at base ${String(baseCommit).slice(0, 12)} (${listed}) and passed at head ${head.slice(0, 12)}`;
    if (!held.some(line => line.number === clause.number && line.text === text.slice(text.indexOf(': ') + 2))) notes.push(text);
  }
  return notes;
}

/** The stored receipts on a thread, newest per clause: what `pullboard show` prints and a reviewer cites. */
export function clauseReceipts(thread) {
  const byClause = new Map();
  for (const entry of thread ?? []) {
    const match = entry.type === 'fact' && entry.kind === 'note' ? RECEIPT.exec(String(entry.text).trim()) : null;
    if (match) byClause.set(Number(match[1]), { number: Number(match[1]), text: match[2] });
  }
  return [...byClause.values()].sort((a, b) => a.number - b.number);
}

/**
 * Judge one named test file's outcomes at an item's base commit and at its head. A clause is proven only when at least
 * one case failed on an assertion at base and every case ran and passed at head. Why: a load error, zero cases or a
 * skip at base fails for reasons unrelated to the change, so it would tick a clause no behaviour backs. It reads only
 * the rows it is handed and runs nothing.
 *
 * @param {{ file: string, name: string, passed: boolean, skipped: boolean, failure?: 'assertion' | 'error' }[] | null | undefined} base - Outcome rows at the base commit.
 * @param {{ file: string, name: string, passed: boolean, skipped: boolean }[] | null | undefined} head - Outcome rows at the head commit.
 * @param {string} file - The test file the clause names.
 * @returns {{ proven: boolean, reason: string, cases: string[] }} `cases` names the base cases that failed on an assertion.
 */
export function failBeforePassAfter(base, head, file) {
  const own = rows => (Array.isArray(rows) ? rows : []).filter(row => row && row.file === file);
  const before = own(base), after = own(head);
  const verdict = (proven, reason, cases = []) => ({ proven, reason, cases });
  if (!before.length) return verdict(false, 'zero tests ran at base');
  const failed = before.filter(row => !row.passed && !row.skipped);
  const asserted = failed.filter(row => row.failure === 'assertion');
  if (!asserted.length) {
    if (failed.length) return verdict(false, 'base failed without an assertion failure (a load error or crash does not count)');
    return verdict(false, before.every(row => row.skipped) ? 'every case was skipped at base' : 'no case failed at base');
  }
  if (!after.length) return verdict(false, 'zero tests ran at head');
  if (after.some(row => row.skipped || !row.passed)) return verdict(false, 'a case did not pass at head');
  return verdict(true, 'failed on an assertion at base and passed at head', asserted.map(row => row.name));
}
