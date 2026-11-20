import { TWO_TIER_DIAGNOSIS_ENGINE } from '../../../state/index.js';
import { ENGINE_VERSION } from '../../../state/index.js';
/** The fixed reasons a release names, kept free of board imports so the release path loads without a cycle [C7]. */
import { Refused } from "../../../kernel/index.js";
import { INFRA_RELEASE_ENGINE } from '../../../state/light.js';
import { TAKEN_OVER_RELEASE_ENGINE } from '../../../state/light.js';
import { REVIEW_RELEASE_REASON_ENGINE } from '../../../state/light.js';

/** The fixed list a release names; OTHER alone carries free text in the release note. */
export const RELEASE_REASONS = Object.freeze(['INELIGIBLE', 'ROUTED_ELSEWHERE', 'BLOCKED', 'BUDGET', 'TAKEN_OVER', 'DIAGNOSIS_WRONG', 'INFRA', 'OTHER', 'BAR', 'FAMILY', 'TOO_LARGE']);

/** The codes a review release names under review.releaseReasons: why a reviewer gave the review back [C7,#8920]. */
export const REVIEW_RELEASE_REASONS = Object.freeze(['BAR', 'FAMILY', 'INFRA', 'TOO_LARGE']);

/** Codes only a review release may carry; a build release names one of the older reasons. */
export const REVIEW_ONLY_REASONS = Object.freeze(['BAR', 'FAMILY', 'TOO_LARGE']);

/** A release carries a code from the fixed list; OTHER and INELIGIBLE also need their text in the note. */
export function releaseReasonProblem(code, note, engine = ENGINE_VERSION) {
  if (!RELEASE_REASONS.includes(code)) return new Refused('RELEASE_REASON', `a release names why: --reason ${RELEASE_REASONS.join('|')} (OTHER also needs --note "what happened")`);
  if (code === 'DIAGNOSIS_WRONG' && engine < TWO_TIER_DIAGNOSIS_ENGINE) return new Refused('ENGINE_VERSION', 'wrong-diagnosis releases need the current engine; upgrade Pullboard');
  if (code === 'DIAGNOSIS_WRONG' && !(typeof note === 'string' && note.trim())) return new Refused('DIAGNOSIS_WRONG', 'say what was wrong with --note so a capable seat can correct the diagnosis');
  if (code === 'TAKEN_OVER' && engine < TAKEN_OVER_RELEASE_ENGINE) return new Refused('ENGINE_VERSION', 'taken-over releases require the current engine; upgrade Pullboard on every linked device');
  if (code === 'INFRA' && engine < INFRA_RELEASE_ENGINE) return new Refused('ENGINE_VERSION', 'infrastructure releases require the current engine; upgrade Pullboard on every linked device');
  if (REVIEW_ONLY_REASONS.includes(code) && engine < REVIEW_RELEASE_REASON_ENGINE) return new Refused('ENGINE_VERSION', 'review release reasons require the current engine; upgrade Pullboard on every linked device');
  if (code === 'INELIGIBLE' && !(typeof note === 'string' && note.trim())) return new Refused('RELEASE_REASON', 'INELIGIBLE needs the reason in --note "why it cannot be built as written" so the re-bar has something to act on');
  if (code === 'OTHER' && !(typeof note === 'string' && note.trim())) return new Refused('RELEASE_REASON', 'OTHER needs the reason in --note "what happened"');
  return null;
}
