import { PROOF_RUN_ENGINE } from '../../../../state/light.js';
import { EXPECTED_BUILD_ENGINE } from '../../../../state/light.js';
import { BAR_READY_ENGINE } from '../../../../state/light.js';
import { barReadySetting } from '../bar/ready.js';
/** A selector gap is an evidence-bound report, not a builder verdict [C7,V4,H16]. */
/** Preserve the proof and expected-build floors, plus an enabled bar-ready setting [C7,H16]. */
function minimumEngine(args, board) {
  return Math.max(PROOF_RUN_ENGINE, EXPECTED_BUILD_ENGINE, board && barReadySetting(board).enabled ? BAR_READY_ENGINE : 1);
}
/** Attribute the selector-gap report to its reviewing seat [C7,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: 'recordSelectorGap', order: 56, engine: EXPECTED_BUILD_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    SELECTOR_GAP_UNPROVED: 'continue the ordinary review path; selector gaps require a recorded native failing review receipt outside the gate selection',
  }) });
