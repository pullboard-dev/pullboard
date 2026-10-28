/** The fixed reasons a release names, kept free of board imports so the release path loads without a cycle [C7]. */
import { Refused } from './refused.js';

/** The fixed list a release names; OTHER alone carries free text in the release note. */
export const RELEASE_REASONS = Object.freeze(['INELIGIBLE', 'ROUTED_ELSEWHERE', 'BLOCKED', 'BUDGET', 'OTHER']);

/** A release carries a code from the fixed list; OTHER also needs its text in the note. */
export function releaseReasonProblem(code, note) {
  if (!RELEASE_REASONS.includes(code)) return new Refused('RELEASE_REASON', `a release names why: --reason ${RELEASE_REASONS.join('|')} (OTHER also needs --note "what happened")`);
  if (code === 'OTHER' && !(typeof note === 'string' && note.trim())) return new Refused('RELEASE_REASON', 'OTHER needs the reason in --note "what happened"');
  return null;
}
