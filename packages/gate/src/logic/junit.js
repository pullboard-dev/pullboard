/** Read a JUnit XML report into case outcomes, with a coded reason instead of a throw on damaged XML; also the report counts, clause ticks, per-language report commands and cargo libtest cases built on them [C7]. */
import { LANGUAGES } from './language-rows.js';

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };

/** Decode the five XML entities in an attribute value. */
function unescapeXml(text) {
  return text.replace(/&(?:lt|gt|quot|apos|amp);/gu, entity => ENTITIES[entity]);
}

/** The attributes of one tag's text as a name to value object. */
export function junitAttributes(tag) {
  const found = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) found[match[1]] = unescapeXml(match[2] ?? match[3]);
  return found;
}

/** Each testcase name with pass, fail or skip; damaged or empty XML gives no cases and a reason code, never a throw [C7]. */
export function junitCases(xml) {
  if (typeof xml !== 'string' || !/<(?:testsuites|testsuite)[\s>]/u.test(xml)) return { cases: [], reason: 'JUNIT_UNREADABLE' };
  const opens = (xml.match(/<testcase\b/gu) ?? []).length;
  const closes = (xml.match(/<\/testsuite>/gu) ?? []).length + (xml.match(/<testsuite\b[^>]*\/>/gu) ?? []).length;
  const suites = (xml.match(/<testsuite\b/gu) ?? []).length;
  if (suites > closes || opens === 0 && !/<testsuite\b/u.test(xml)) return { cases: [], reason: 'JUNIT_DAMAGED' };
  const cases = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/gu)) {
    const name = junitAttributes(match[1]).name;
    if (name === undefined) return { cases: [], reason: 'JUNIT_DAMAGED' };
    const body = match[3] ?? '';
    const outcome = /<(?:failure|error)\b/u.test(body) ? 'fail' : /<skipped\b/u.test(body) ? 'skip' : 'pass';
    cases.push({ name, outcome });
  }
  if (opens !== cases.length) return { cases: [], reason: 'JUNIT_DAMAGED' };
  return { cases, reason: null };
}

/** Pass, fail and skip counts from a JUnit report, so a pytest or go run shows real receipt counts instead of "unknown" [C7]. Damaged or empty XML gives null counts and junitCases' reason code, never a throw. */
export function junitCounts(xml) {
  const { cases, reason } = junitCases(xml);
  if (reason !== null) return { pass: null, fail: null, skip: null, reason };
  const counts = { pass: 0, fail: 0, skip: 0, reason: null };
  for (const { outcome } of cases) counts[outcome] += 1;
  return counts;
}

/** Match a JUnit report's cases to an item's [test] clauses, deciding which to tick and which a failing case blocks [C7]. */

/** The clause number a case name starts with ("clause 3: ..."), or null when it names none. */
function clauseOf(name) {
  const match = /^clause\s+(\d+)\s*:/iu.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Which [test] clauses a report proves. `cases` is the `cases` list junitCases returns; `clauses` is a list of
 * `{ number, kind }`. Why: a clause whose named cases all passed is proved by the report; a failing case blocks its
 * clause and is named; a clause with no case in the report is left alone, neither ticked nor failed, and skipped
 * cases prove nothing. Pure: no I/O.
 */
export function junitClauseTicks(cases, clauses) {
  const ticked = [];
  const failed = [];
  for (const clause of clauses) {
    if (clause.kind !== 'test') continue;
    const mine = cases.filter(row => clauseOf(row.name) === clause.number);
    if (!mine.length) continue;
    const bad = mine.filter(row => row.outcome === 'fail');
    if (bad.length) { for (const row of bad) failed.push({ number: clause.number, name: row.name }); continue; }
    if (mine.every(row => row.outcome === 'pass')) ticked.push(clause.number);
  }
  return { ticked, failed };
}

/** The gate command that writes a JUnit report, per detected language, and where the report lands [C7]. */

/**
 * One row per language with a report form, read from LANGUAGES (make and the rest have none).
 * needs names the extra package or config the tool requires before it can write JUnit; null when the tool writes it alone.
 */
const junitOf = language => LANGUAGES.find(row => row.language === language)?.junit ?? null;

/**
 * The JUnit-writing command for one language: the command, the report file or folder it writes, and any extra package it needs.
 * Why: init sets a plain test command, so landing names no failure of a non-Node repo until a person finds each tool's report flag.
 *
 * @param {string} language a language name as detectLanguages returns it
 * @returns {{ command: string, report: string, needs: string | null } | null} null for make or an unknown name, never a guess
 */
export function junitCommand(language) {
  const row = typeof language === 'string' ? junitOf(language) : null;
  return row === null ? null : { ...row };
}

/** Every language with a report form, sorted. */
export const JUNIT_LANGUAGES = Object.freeze(LANGUAGES.filter(row => row.junit !== null).map(row => row.language).sort());

/** Read plain `cargo test` (libtest) output into {name, outcome, message?} cases in the junitCases shape, with no extra tool [C7]. */
export function cargoTestCases(output) {
  if (typeof output !== 'string') return { cases: [], reason: 'CARGO_UNREADABLE' };
  const lines = output.split(/\r?\n/u);
  const cases = [];
  for (const line of lines) {
    const match = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/u.exec(line);
    if (match) cases.push({ name: match[1], outcome: match[2] === 'ok' ? 'pass' : match[2] === 'FAILED' ? 'fail' : 'skip' });
  }
  if (cases.length === 0) return { cases: [], reason: 'CARGO_UNREADABLE' };
  for (let at = 0; at < lines.length; at += 1) {
    const head = /^---- (\S+) stdout ----$/u.exec(lines[at]);
    if (!head) continue;
    const failing = cases.find(found => found.name === head[1] && found.outcome === 'fail' && found.message === undefined);
    if (!failing) continue;
    for (let next = at + 1; next < lines.length && !/^---- /u.test(lines[next]); next += 1) {
      if (/panicked at /u.test(lines[next])) { failing.message = lines[next].trim(); break; }
    }
  }
  return { cases, reason: null };
}

/* Per-language affected-test rows: the command that runs only what a change touches, and the unit selection picks by [C7]. Kept here so the gate light door loads no extra module for them. */

/** The order AFFECTED_LANGUAGES has always listed its first rows in; any language past these follows in LANGUAGES order. */
const AFFECTED_ORDER = ['python', 'node', 'go', 'rust', 'csharp', 'php', 'ruby', 'deno', 'bun', 'cmake', 'make', 'maven', 'gradle', 'swift'];

/** The rows with an affected answer, in AFFECTED_ORDER: a command ({units} is every selected unit in one command; {unit} repeats it once per unit) or an AFFECTED_NONE reason, read from LANGUAGES. */
const AFFECTED_FROM = LANGUAGES.filter(row => row.affected !== null)
  .map((row, at) => ({ language: row.language, affected: row.affected, at: AFFECTED_ORDER.includes(row.language) ? AFFECTED_ORDER.indexOf(row.language) : AFFECTED_ORDER.length + at }))
  .sort((left, right) => left.at - right.at);

/**
 * The affected-test row for a language: {affectedTests, selectionUnit, reason: null}, or a null command with a reason, never a guessed command [C7].
 *
 * @param {string} language a language row id such as python, go or rust
 * @returns {{affectedTests: string | null, selectionUnit: string | null, reason: string | null}}
 */
export function affectedRow(language) {
  const row = AFFECTED_FROM.find(found => found.language === language)?.affected;
  if (row?.affectedTests) return { ...row, reason: null };
  return { affectedTests: null, selectionUnit: null, reason: row?.none ?? `AFFECTED_UNKNOWN: ${String(language)} has no affected-test row; run the full gate or declare affectedSuites` };
}

/** Every language that has a row or an explicit no-row answer. */
export const AFFECTED_LANGUAGES = AFFECTED_FROM.map(row => row.language);
