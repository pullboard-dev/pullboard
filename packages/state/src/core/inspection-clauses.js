/** Clause inspection: a numbered criterion is ticked clause by clause, each with its evidence, before submit (#2050). */
import { Refused } from '../../../kernel/index.js';

export const EVIDENCE_KINDS = Object.freeze(['test', 'command', 'screenshot', 'measurement', 'reasoning']);
const KINDS = EVIDENCE_KINDS.join('|');
const CLAUSE_MARKER = /(?:^|\s)(\d+)[.)]\s+/gu;
const DECLARED = new RegExp(`\\[(${KINDS})\\]\\s*[.;]?\\s*$`, 'u');
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
export function clauseInspectionProblem(item, thread, { greenFiles = new Set(), gateFiles = new Set() } = {}) {
  const clauses = criterionClauses(item.item_criterion);
  if (!clauses.length) return null;
  const ticks = clauseTicks(thread, item.item_owner);
  const problems = [];
  for (const clause of clauses) {
    const tick = ticks.get(clause.number);
    const label = `clause ${clause.number} (${clause.text.slice(0, 80)})`;
    const proven = () => [...greenFiles].some(file => file && tick.evidence.includes(file));
    if (!tick && gateNamedFile(clause, new Set([...gateFiles, ...greenFiles]), item)) continue;
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
