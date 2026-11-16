/** A criterion declares the evidence each numbered outcome will require [C7]. */
import { Refused } from '../../../kernel/index.js';
import { criterionClauses } from './clauses.js';
import { EVIDENCE_KINDS } from './clauses.js';
import { lintBar } from './bar-lint.js';

/** Flag every reasoning declaration without presenting it as executable proof. */
export function clauseEvidenceWarnings(criterion) {
  return criterionClauses(criterion, { single: true }).filter(clause => clause.kind === 'reasoning').map(clause => ({
    code: 'CLAUSE_REASONING_WEAK', clause: clause.number, kind: clause.kind,
    message: `clause ${clause.number} uses reasoning (weakest evidence); observable behaviour needs a test, command, screenshot or measurement`,
  }));
}

/** Refuse undeclared or conflicting evidence before a new check or item mutation can run. */
export function requireCriterionEvidence(criterion) {
  const clauses = criterionClauses(criterion, { single: true });
  const missing = clauses.filter(clause => !clause.kind).map(clause => clause.number);
  if (missing.length) throw new Refused('CLAUSE_EVIDENCE_REQUIRED', `clause ${missing.join(', ')} has no evidence kind; end each numbered clause with exactly one [${EVIDENCE_KINDS.join('|')}] declaration`);
  const suffix = new RegExp(`\\[(${EVIDENCE_KINDS.join('|')})\\]\\s*[.;]?\\s*$`, 'u');
  const multiple = clauses.filter(clause => suffix.test(clause.text.replace(suffix, '').trim())).map(clause => clause.number);
  if (multiple.length) throw new Refused('CLAUSE_EVIDENCE_KIND', `clause ${multiple.join(', ')} declares more than one evidence kind; split its outcomes or choose one [${EVIDENCE_KINDS.join('|')}] declaration`);
  const observable = clauses.filter(clause => clause.kind === 'reasoning'
    && /\b(?:exits?|prints?|refuses?|passes?|returns?)\b|\bunder\s+\d+(?:\.\d+)?\s*(?:ms|s)\b/iu.test(clause.text)).map(clause => clause.number);
  if (observable.length) throw new Refused('CLAUSE_REASONING_ONLY', `clause ${observable.join(', ')} names an observable outcome with reasoning alone; declare test, command, screenshot or measurement evidence for that outcome`);
  return clauseEvidenceWarnings(criterion);
}

/**
 * Refuse a criterion with a plain fault, naming the fix, and return the warnings for the rest.
 *
 * @param {string|undefined} criterion
 * @param {{ allowLong?: boolean, warnUnnamedTest?: boolean, brief?: string }} [options]
 * @returns {{ code: string, clause: number, message: string }[]}
 */
export function guardBar(criterion, options) {
  if (criterion === undefined) return [];
  const { problems, fix, warnings } = lintBar(criterion, options);
  if (problems.length) throw new Refused('BAR_AMBIGUOUS', `this bar is not checkable yet: ${problems.join('; ')}`, `${fix.join('; ')}, then run the command again`);
  return warnings;
}
