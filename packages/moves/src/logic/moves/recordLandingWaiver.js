import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by recordLandingWaiver, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 8;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "recordLandingWaiver", order: 43, engine: 8,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "B26_PERSON_CHANNEL": "record it as the person through pullboard view or the person's own terminal",
  "LAND_PERSON_ONLY": "ask the person to waive it from their terminal or pullboard view",
  "LAND_WAIVER": "pullboard land --waive <test> --until <date> --reason \"why\""
}) });
