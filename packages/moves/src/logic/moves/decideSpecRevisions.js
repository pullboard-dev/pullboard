/** A new person-only revision disposition cannot be replayed by an older reader [P6,H16]. */
import { SPEC_REVISION_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";

/** Retain every applicable surrounding operation floor, including overlapping payload features. */
function minimumEngine(args) {
  return Math.max(SPEC_REVISION_ENGINE, args[0]?.landingFence === undefined ? 0 : LANDING_LEASE_ENGINE,
    typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:') ? RIGOR_AUTO_ENGINE : 0,
    typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:') ? BOARD_SENTINEL_ENGINE : 0);
}

/** The operation's first argument carries its authenticated person actor. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: 'decideSpecRevisions', engine: SPEC_REVISION_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({ SPEC_REVISION: 'refresh Needs you and decide the exact pending proposal',
    B26_PERSON_APPROVAL: 'ask the person to decide in pullboard view' }) });
