/** Close a trunk test defect whose recorded cases passed at a trunk commit [C7,V4,H16]. */
import { LANDING_DEFECT_CLOSE_ENGINE } from '../../../../state/light.js';

/** The move exists only from its own engine onward, so an older replica never drops a closing [C7,H16]. */
function minimumEngine() { return LANDING_DEFECT_CLOSE_ENGINE; }

/** Attribute the closing to the landing coordinator that recorded it [C7,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: 'closeLandingTestDefect', engine: LANDING_DEFECT_CLOSE_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    COORDINATOR_ONLY: 'ask the coordinator to do it: pullboard shout coordinator --kind question "<what you need>"',
    ENGINE_VERSION: 'upgrade Pullboard: npm install -g pullboard@latest',
    LAND_TEST_DEFECT: 'commit a correction to the test named by the held defect, or ask the person for an expiring test waiver; then run pullboard land again',
  }) });
