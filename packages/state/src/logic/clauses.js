/** Clause inspection: a numbered criterion is ticked clause by clause, each with its evidence, before submit (#2050). */
import { Refused } from '../../../kernel/index.js';

export const EVIDENCE_KINDS = Object.freeze(['test', 'command', 'screenshot', 'measurement', 'reasoning']);
const KINDS = EVIDENCE_KINDS.join('|');
const CLAUSE_MARKER = /(?:^|\s)(\d+)[.)]\s+/gu;
const DECLARED = new RegExp(`\\[(${KINDS})\\]\\s*[.;]?\\s*$`, 'u');
const RUN_EVIDENCE = /^green pullboard (?:test|check) run of \S/u;
const TICK = new RegExp(`^clause (\\d+) \\[(${KINDS})\\]:\\s*(\\S[\\s\\S]*)$`, 'u');

/** The clauses of a criterion, or [] when it is free text: sequential numbered outcomes. */
export function criterionClauses(criterion, { single = false } = {}) {
  const source = String(criterion ?? '');
  const markers = [...source.matchAll(CLAUSE_MARKER)];
  if (!markers.length || (markers.length > 1 && markers.some((match, index) => Number(match[1]) !== index + 1))) return [];
  const firstStart = markerStart(markers[0]);
  if (!single && markers.length === 1 && source.slice(0, firstStart).trim()
    && !source.slice(0, firstStart).trim().endsWith(':')) return [];
  const clauses = markers.map((marker, index) => {
    const start = markerStart(marker);
    const header = /^\d+[.)]\s+/u.exec(source.slice(start));
    const contentStart = start + header[0].length;
    const end = index + 1 < markers.length ? markerStart(markers[index + 1]) : source.length;
    const text = source.slice(contentStart, end).trim().replace(/[;,]\s*$/u, '').trim();
    return { number: Number(marker[1]), text, kind: DECLARED.exec(text)?.[1] ?? null };
  });
  return clauses.every(clause => clause.text) ? clauses : [];
}

/** Locate the digit in a marker whether it begins a line or follows an inline separator. */
function markerStart(marker) {
  return marker.index + marker[0].lastIndexOf(marker[1]);
}

/**
 * The gate-run test file a [test] clause names, or null: a file in `gateFiles` that the clause text or the item's "Test:" brief quotes by
 * path or base name. Why: builders may not run tests, so the gate's own run is the evidence and the clause is ticked by it [C7].
 */
export function gateNamedFile(clause, gateFiles, item = null) {
  if (clause.kind !== 'test') return null;
  const declared = /(?:^|\n)Test:([\s\S]*)$/u.exec(item?.item_brief ?? '')?.[1] ?? '';
  const text = `${clause.text}\n${declared}`.toLowerCase();
  return [...gateFiles].find(file => file && (text.includes(file.toLowerCase()) || text.includes(file.split('/').pop().toLowerCase()))) ?? null;
}

/**
 * The tick each clause carries from the builder, read from ordinary note facts: the latest, except that a hand-written
 * note never replaces a recorded green run. Why: #3793 (11 Nov) wrote its own notes after pullboard test ticked both
 * clauses, the notes hid the run, and submit sent the seat to a second 254 s runner trip for the same file [C7].
 */
export function clauseTicks(thread, owner) {
  const ticks = new Map();
  for (const entry of thread) {
    if (entry.type !== 'fact' || entry.kind !== 'note' || entry.by !== owner) continue;
    const match = TICK.exec(String(entry.text).trim());
    if (!match) continue;
    const tick = { kind: match[2], evidence: match[3].trim() };
    const held = ticks.get(Number(match[1]));
    if (held && RUN_EVIDENCE.test(held.evidence) && !RUN_EVIDENCE.test(tick.evidence)) continue;
    ticks.set(Number(match[1]), tick);
  }
  return ticks;
}

const SHELL_SYNTAX = /[;&|<>`$()!\\\n'"*?]/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?js$/u;

/**
 * The test files a frozen check runs when it is one plain command naming them, such as `node <runner> a.test.js`; [] for
 * anything a test run cannot stand in for: shell syntax, a negation, or no test file at all.
 */
export function checkTestFiles(check) {
  const text = String(check ?? '').trim();
  if (!text || SHELL_SYNTAX.test(text)) return [];
  return text.split(/\s+/u).filter(word => TEST_FILE.test(word)).map(word => word.replace(/^\.\//u, ''));
}

/**
 * A refusal naming every clause that is unticked or ticked with evidence of the wrong kind; null when all are met.
 * A test tick names a case that cites its clause, or a test file among `greenFiles`: the files a green proof of this
 * exact commit ran. Why: the gate already proved that file; refusing the submit until the builder retypes the case
 * name with "clause N" cost two or three submits per item on 6 Nov (588 tick notes in a morning) [C7].
 */
export function clauseInspectionProblem(item, thread, { greenFiles = new Set(), gateFiles = new Set() } = {}) {
  const clauses = criterionClauses(item.item_criterion);
  if (!clauses.length) return null;
  const ticks = clauseTicks(thread, item.item_owner);
  const problems = [];
  const testClauses = [];
  for (const clause of clauses) {
    const tick = ticks.get(clause.number);
    const label = `clause ${clause.number} (${clause.text.slice(0, 80)})`;
    const proven = () => RUN_EVIDENCE.test(tick.evidence) || [...greenFiles].some(file => file && tick.evidence.includes(file));
    if (!tick && gateNamedFile(clause, new Set([...gateFiles, ...greenFiles]), item)) continue;
    if (!tick) { problems.push(`${label} has no evidence`); if (clause.kind === null || clause.kind === 'test') testClauses.push(clause); }
    else if (clause.kind && clause.kind !== tick.kind) {
      problems.push(`${label} needs ${clause.kind} evidence, not ${tick.kind}${tick.kind === 'reasoning' ? ' (the weakest kind)' : ''}`);
    } else if (tick.kind === 'test' && !new RegExp(`\\bclause\\s+${clause.number}\\b`, 'iu').test(tick.evidence) && !proven()) {
      problems.push(`${label} needs a named test case citing clause ${clause.number}, or a test file this commit's green proof ran`);
      testClauses.push(clause);
    }
  }
  if (!problems.length) return null;
  const tickWith = `tick each with: pullboard fact ${item.item_id} note "clause <n> [${EVIDENCE_KINDS.join('|')}]: <the evidence>", then submit again`;
  if (!testClauses.length) return new Refused('CLAUSE_UNTICKED', `${problems.join('; ')}; ${tickWith}`);
  return new Refused('CLAUSE_UNTICKED', `${problems.join('; ')}; ${testStep(item, testClauses).message} or ${tickWith}`, testStep(item, testClauses).next);
}

/**
 * The one command that ticks an unticked test clause: pullboard check <id> when the item has a frozen check, since it runs
 * the check and writes every test tick itself; otherwise pullboard test on a file a clause names.
 * Why: two light-route seats released #3544 and #3567 on 8 Nov after green test runs, because the old step said to hand-write a case name [C7].
 *
 * @param {object} item - The item row.
 * @param {{ text: string }[]} testClauses - The unticked test clauses.
 * @returns {{ message: string, next: string }}
 */
function testStep(item, testClauses) {
  const checkFiles = checkTestFiles(item.item_check);
  if (checkFiles.length) {
    // The one runner trip: the run ticks the clauses and its green is the receipt the gate's item check reuses [C7].
    const command = `pullboard test ${checkFiles.join(' ')}`;
    return { message: `run ${command}, the item's check files, which ticks every test clause when green`, next: `${command}, then submit again` };
  }
  if (String(item.item_check ?? '').trim()) {
    const command = `pullboard check ${item.item_id}`;
    return { message: `run ${command}, which runs the frozen check and ticks every test clause`, next: `${command}, then submit again` };
  }
  // A path the clause quotes that names a test; no runner's file naming is spelled out in this core file.
  const file = testClauses.flatMap(clause => clause.text.match(/[\w./-]+\/[\w.-]+\.[cm]?[jt]s/gu) ?? []).find(path => /test/u.test(path)) ?? null;
  const command = file ? `pullboard test ${file}` : 'pullboard test <a test file the clause names>';
  return { message: `run ${command}, then tick the clause with its green run`, next: `${command}, then tick the clause and submit again` };
}

/**
 * The tick notes a green `pullboard test` run earns: one per clause that is a test clause (declared [test] or
 * undeclared) when the run covered every test file the item's check names. Why: the run is the proof the clause cites,
 * so the builder never retypes a case name or spends a second run after a green runner proof; a run of only some of
 * the check's files proves only some of it, so it ticks nothing [C7].
 */
export function testRunTickNotes(item, files, head) {
  const clauses = criterionClauses(item.item_criterion);
  const ran = new Set(files.map(file => String(file).replace(/^\.\//u, '')));
  const needed = checkTestFiles(item.item_check);
  if (!clauses.length || !needed.length || !needed.every(file => ran.has(file))) return [];
  return testClauseTickNotes(clauses, `test run of ${files.join(' ')}`, head);
}

/**
 * The tick notes a green `pullboard check` run earns: the frozen check is the proof of every test clause, whether it is a test file
 * or a shell command such as `test ! -e src/x.js`. Why: shell-command checks never name a file `pullboard test` could run [C7].
 */
export function checkRunTickNotes(item, head) {
  const check = String(item.item_check ?? '').trim();
  return check ? testClauseTickNotes(criterionClauses(item.item_criterion), `check run of ${check}`, head) : [];
}

/** One tick note per test clause (declared [test] or undeclared) citing a green run description at a head commit. */
function testClauseTickNotes(clauses, run, head) {
  return clauses.filter(clause => clause.kind === null || clause.kind === 'test')
    .map(clause => `clause ${clause.number} [test]: green pullboard ${run} at ${head}`);
}

/** One reviewer-facing line per clause with its evidence; reasoning is flagged as the weakest kind. */
export function clauseInspectionSummary(item, thread, { gateFiles = new Set() } = {}) {
  const clauses = criterionClauses(item.item_criterion);
  if (!clauses.length) return null;
  const ticks = clauseTicks(thread, item.item_owner);
  return `inspection, clause by clause: ${clauses.map(clause => {
    const named = ticks.has(clause.number) ? null : gateNamedFile(clause, gateFiles, item);
    const tick = named ? { kind: 'test', evidence: `ticked by the gate run of ${named}` } : ticks.get(clause.number);
    return `${clause.number}. ${clause.text.slice(0, 80)} -> ${tick.kind}${tick.kind === 'reasoning' ? ' (weakest evidence)' : ''}: ${tick.evidence}`;
  }).join(' | ')}`;
}
