/** Clause inspection: a numbered criterion is ticked clause by clause, each with its evidence, before submit (#2050). */
import { Refused } from '../../../kernel/index.js';

export const EVIDENCE_KINDS = Object.freeze(['test', 'command', 'screenshot', 'measurement', 'reasoning']);
const KINDS = EVIDENCE_KINDS.join('|');
const CLAUSE_MARKER = /(?:^|\s)(\d+)[.)]\s+/gu;
const DECLARED = new RegExp(`\\[(${KINDS})\\]\\s*[.;]?\\s*$`, 'u');
const RUN_EVIDENCE = /^green pullboard test run of \S/u;
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

/** The latest tick each clause carries from the builder, read from ordinary note facts. */
export function clauseTicks(thread, owner) {
  const ticks = new Map();
  for (const entry of thread) {
    if (entry.type !== 'fact' || entry.kind !== 'note' || entry.by !== owner) continue;
    const match = TICK.exec(String(entry.text).trim());
    if (match) ticks.set(Number(match[1]), { kind: match[2], evidence: match[3].trim() });
  }
  return ticks;
}

/**
 * A refusal naming every clause that is unticked or ticked with evidence of the wrong kind; null when all are met.
 * A test tick names a case that cites its clause, or a test file among `greenFiles`: the files a green proof of this
 * exact commit ran. Why: the gate already proved that file; refusing the submit until the builder retypes the case
 * name with "clause N" cost two or three submits per item on 6 Nov (588 tick notes in a morning) [C7].
 */
export function clauseInspectionProblem(item, thread, { greenFiles = new Set() } = {}) {
  const clauses = criterionClauses(item.item_criterion);
  if (!clauses.length) return null;
  const ticks = clauseTicks(thread, item.item_owner);
  const problems = [];
  for (const clause of clauses) {
    const tick = ticks.get(clause.number);
    const label = `clause ${clause.number} (${clause.text.slice(0, 80)})`;
    const proven = () => RUN_EVIDENCE.test(tick.evidence) || [...greenFiles].some(file => file && tick.evidence.includes(file));
    if (!tick) problems.push(`${label} has no evidence`);
    else if (clause.kind && clause.kind !== tick.kind) {
      problems.push(`${label} needs ${clause.kind} evidence, not ${tick.kind}${tick.kind === 'reasoning' ? ' (the weakest kind)' : ''}`);
    } else if (tick.kind === 'test' && !new RegExp(`\\bclause\\s+${clause.number}\\b`, 'iu').test(tick.evidence) && !proven()) {
      problems.push(`${label} needs a named test case citing clause ${clause.number}, or a test file this commit's green proof ran`);
    }
  }
  if (!problems.length) return null;
  return new Refused('CLAUSE_UNTICKED', `${problems.join('; ')}; tick each with: pullboard fact ${item.item_id} note "clause <n> [${EVIDENCE_KINDS.join('|')}]: <the evidence>", then submit again`);
}

/**
 * The tick notes a green `pullboard test` run earns: one per clause that is a test clause (declared [test] or
 * undeclared) when every file the run named is part of the item's check. Why: the run is the proof the clause cites,
 * so the builder never retypes a case name or spends a second run after a green runner proof [C7].
 */
export function testRunTickNotes(item, files, head) {
  const clauses = criterionClauses(item.item_criterion);
  const check = String(item.item_check ?? '');
  if (!clauses.length || !files.length || !files.every(file => check.includes(file))) return [];
  return clauses.filter(clause => clause.kind === null || clause.kind === 'test')
    .map(clause => `clause ${clause.number} [test]: green pullboard test run of ${files.join(' ')} at ${head}`);
}

/** One reviewer-facing line per clause with its evidence; reasoning is flagged as the weakest kind. */
export function clauseInspectionSummary(item, thread) {
  const clauses = criterionClauses(item.item_criterion);
  if (!clauses.length) return null;
  const ticks = clauseTicks(thread, item.item_owner);
  return `inspection, clause by clause: ${clauses.map(clause => {
    const tick = ticks.get(clause.number);
    return `${clause.number}. ${clause.text.slice(0, 80)} -> ${tick.kind}${tick.kind === 'reasoning' ? ' (weakest evidence)' : ''}: ${tick.evidence}`;
  }).join(' | ')}`;
}
