import { TWO_TIER_DIAGNOSIS_ENGINE } from '../../../state/index.js';
import { ENGINE_VERSION } from '../../../state/index.js';
/** The fixed reasons a release names, kept free of board imports so the release path loads without a cycle [C7]. */
import { Refused } from "../../../kernel/index.js";
import { INFRA_RELEASE_ENGINE } from '../../../state/light.js';
import { TAKEN_OVER_RELEASE_ENGINE } from '../../../state/light.js';

/** The fixed list a release names; OTHER alone carries free text in the release note. */
export const RELEASE_REASONS = Object.freeze(['INELIGIBLE', 'ROUTED_ELSEWHERE', 'BLOCKED', 'BUDGET', 'TAKEN_OVER', 'DIAGNOSIS_WRONG', 'INFRA', 'OTHER']);

/** A release carries a code from the fixed list; OTHER also needs its text in the note. */
export function releaseReasonProblem(code, note, engine = ENGINE_VERSION) {
  if (!RELEASE_REASONS.includes(code)) return new Refused('RELEASE_REASON', `a release names why: --reason ${RELEASE_REASONS.join('|')} (OTHER also needs --note "what happened")`);
  if (code === 'DIAGNOSIS_WRONG' && engine < TWO_TIER_DIAGNOSIS_ENGINE) return new Refused('ENGINE_VERSION', 'wrong-diagnosis releases need the current engine; upgrade Pullboard');
  if (code === 'DIAGNOSIS_WRONG' && !(typeof note === 'string' && note.trim())) return new Refused('DIAGNOSIS_WRONG', 'say what was wrong with --note so a capable seat can correct the diagnosis');
  if (code === 'TAKEN_OVER' && engine < TAKEN_OVER_RELEASE_ENGINE) return new Refused('ENGINE_VERSION', 'taken-over releases require the current engine; upgrade Pullboard on every linked device');
  if (code === 'INFRA' && engine < INFRA_RELEASE_ENGINE) return new Refused('ENGINE_VERSION', 'infrastructure releases require the current engine; upgrade Pullboard on every linked device');
  if (code === 'OTHER' && !(typeof note === 'string' && note.trim())) return new Refused('RELEASE_REASON', 'OTHER needs the reason in --note "what happened"');
  return null;
}
