import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by approveOutside, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { OUTSIDE_INTAKE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 1;
}
/** Keep outside-source isolation as the original maximum over the older engine rule. */
function minimumEngine(args, board, at) {
  const outside = true;
  return Math.max(outside ? OUTSIDE_INTAKE_ENGINE : 1, existingEngine(args, board, at));
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "approveOutside", order: 3, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "B26_PERSON_CHANNEL": "record it as the person through pullboard view or the person's own terminal",
  "OUTSIDE_SOURCE": "fetch the exact GitHub source metadata and its immutable commit/tree before intake"
}) });
