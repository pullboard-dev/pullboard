/** The fixed reasons a release names, kept free of board imports so the release path loads without a cycle [C7]. */
import { Refused } from "../../../kernel/index.js";
import { TAKEN_OVER_RELEASE_ENGINE } from '../../../../src/taken-over-release-engine.js';

/** The fixed list a release names; OTHER alone carries free text in the release note. */
export const RELEASE_REASONS = Object.freeze(['INELIGIBLE', 'ROUTED_ELSEWHERE', 'BLOCKED', 'BUDGET', 'TAKEN_OVER', 'OTHER']);

/** A release carries a code from the fixed list; OTHER also needs its text in the note. */
export function releaseReasonProblem(code, note, engine = TAKEN_OVER_RELEASE_ENGINE) {
  if (!RELEASE_REASONS.includes(code)) return new Refused('RELEASE_REASON', `a release names why: --reason ${RELEASE_REASONS.join('|')} (OTHER also needs --note "what happened")`);
  if (code === 'TAKEN_OVER' && engine < TAKEN_OVER_RELEASE_ENGINE) return new Refused('ENGINE_VERSION', 'taken-over releases require the current engine; upgrade Pullboard on every linked device');
  if (code === 'OTHER' && !(typeof note === 'string' && note.trim())) return new Refused('RELEASE_REASON', 'OTHER needs the reason in --note "what happened"');
  return null;
}
