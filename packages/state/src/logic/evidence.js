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

/**
 * Refuse undeclared or conflicting evidence before a new check or item mutation can run.
 *
 * Every fault of the bar is listed at once, each with its own fix, so one refusal teaches the whole repair: the
 * code is the first fault's, the message joins them, and the next line carries every fix. A [measurement] clause with
 * no number is listed only beside another fault, since the bar lint refuses it alone with its own fix [C7,#12015].
 *
 * @param {string} criterion
 * @returns {{ code: string, clause: number, kind: string, message: string }[]}
 */
export function requireCriterionEvidence(criterion) {
  const clauses = criterionClauses(criterion, { single: true });
  const faults = [];
  const fault = (code, numbers, said, fix) => faults.push({ code, said: `clause ${numbers.join(', ')} ${said}`, fix: `clause ${numbers.join(', ')}: ${fix}` });
  const missing = clauses.filter(clause => !clause.kind).map(clause => clause.number);
  if (missing.length) fault('CLAUSE_EVIDENCE_REQUIRED', missing, `has no evidence kind; end each numbered clause with exactly one [${EVIDENCE_KINDS.join('|')}] declaration`, `end it with one of [${EVIDENCE_KINDS.join('|')}]`);
  const suffix = new RegExp(`\\[(${EVIDENCE_KINDS.join('|')})\\]\\s*[.;]?\\s*$`, 'u');
  const multiple = clauses.filter(clause => suffix.test(clause.text.replace(suffix, '').trim())).map(clause => clause.number);
  if (multiple.length) fault('CLAUSE_EVIDENCE_KIND', multiple, `declares more than one evidence kind; split its outcomes or choose one [${EVIDENCE_KINDS.join('|')}] declaration`, 'split its outcomes or keep one evidence tag');
  const observable = clauses.filter(clause => clause.kind === 'reasoning'
    && /\b(?:exits?|prints?|refuses?|passes?|returns?)\b|\bunder\s+\d+(?:\.\d+)?\s*(?:ms|s)\b/iu.test(clause.text)).map(clause => clause.number);
  if (observable.length) fault('CLAUSE_REASONING_ONLY', observable, 'names an observable outcome with reasoning alone; declare test, command, screenshot or measurement evidence for that outcome', 'declare test, command, screenshot or measurement evidence');
  if (faults.length) {
    const unmeasured = clauses.filter(clause => clause.kind === 'measurement' && !/\d/u.test(clause.text.replace(/\[measurement\]/u, ''))).map(clause => clause.number);
    if (unmeasured.length) fault('BAR_AMBIGUOUS', unmeasured, 'is a [measurement] with no number', 'put the number it must meet in the clause');
    throw new Refused(faults[0].code, faults.map(entry => entry.said).join('; '), `${faults.map(entry => entry.fix).join('; ')}, then run the command again`);
  }
  return clauseEvidenceWarnings(criterion);
}

/**
 * Refuse a criterion with a plain fault, naming the fix, and return the warnings for the rest.
 *
 * With `refuseEmpty`, a missing, blank or unnumbered criterion is refused BAR_EMPTY; without it an undefined criterion returns no warnings [C7].
 *
 * @param {string|undefined} criterion
 * @param {{ allowLong?: boolean, warnUnnamedTest?: boolean, brief?: string, refuseEmpty?: boolean }} [options]
 * @returns {{ code: string, clause: number, message: string }[]}
 */
export function guardBar(criterion, options) {
  if (options?.refuseEmpty === true && !criterionClauses(String(criterion ?? ''), { single: true }).length) {
    throw new Refused('BAR_EMPTY', 'this bar is empty or has no numbered clause, so it is not checkable', 'give it numbered clauses with pullboard edit <id> --criterion "1. ... [test]" --reason "...", then run the command again');
  }
  if (criterion === undefined) return [];
  const { problems, fix, warnings } = lintBar(criterion, options);
  if (problems.length) throw new Refused('BAR_AMBIGUOUS', `this bar is not checkable yet: ${problems.join('; ')}`, `${fix.join('; ')}, then run the command again`);
  return warnings;
}
