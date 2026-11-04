/** Clause inspection: a numbered criterion is ticked clause by clause, each with its evidence, before submit (#2050). */
import { Refused } from '../../../kernel/index.js';

export const EVIDENCE_KINDS = Object.freeze(['test', 'command', 'screenshot', 'measurement', 'reasoning']);
const KINDS = EVIDENCE_KINDS.join('|');
const CLAUSE = /^\s*(\d+)[.)]\s+(\S.*)$/u;
const DECLARED = new RegExp(`\\[(${KINDS})\\]\\s*[.;]?\\s*$`, 'u');
const TICK = new RegExp(`^clause (\\d+) \\[(${KINDS})\\]:\\s*(\\S[\\s\\S]*)$`, 'u');

/** The clauses of a criterion, or [] when it is free text: two or more sequential numbered lines by default; single includes every numbered line for authoring validation. */
export function criterionClauses(criterion, { single = false } = {}) {
  const text = String(criterion ?? '');
  const lines = single ? text.replace(/(?:^|[ \t])(\d+)[.)]\s+/gu, '\n$1. ') : text;
  const found = lines.split(/\r?\n/u).map(line => CLAUSE.exec(line)).filter(Boolean);
  if (found.length < (single ? 1 : 2) || !single && found.some((match, index) => Number(match[1]) !== index + 1)) return [];
  return found.map(match => ({ number: Number(match[1]), text: match[2].trim(), kind: DECLARED.exec(match[2])?.[1] ?? null }));
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

/** A refusal naming every clause that is unticked or ticked with evidence of the wrong kind; null when all are met. */
export function clauseInspectionProblem(item, thread) {
  const clauses = criterionClauses(item.item_criterion);
  if (!clauses.length) return null;
  const ticks = clauseTicks(thread, item.item_owner);
  const problems = [];
  for (const clause of clauses) {
    const tick = ticks.get(clause.number);
    const label = `clause ${clause.number} (${clause.text.slice(0, 80)})`;
    if (!tick) problems.push(`${label} has no evidence`);
    else if (clause.kind && clause.kind !== tick.kind) {
      problems.push(`${label} needs ${clause.kind} evidence, not ${tick.kind}${tick.kind === 'reasoning' ? ' (the weakest kind)' : ''}`);
    }
  }
  if (!problems.length) return null;
  return new Refused('CLAUSE_UNTICKED', `${problems.join('; ')}; tick each with: pullboard fact ${item.item_id} note "clause <n> [${EVIDENCE_KINDS.join('|')}]: <the evidence>", then submit again`);
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
