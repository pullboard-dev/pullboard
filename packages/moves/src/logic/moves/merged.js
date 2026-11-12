import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
import { FLAKE_RATCHET_ENGINE } from '../../../../state/light.js';
/** Routing metadata owned by merged, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { OUTSIDE_INTAKE_ENGINE } from "../../../../state/light.js";
import { outsideSource } from "../../../../items/light.js";
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
  const outside = board && Boolean(outsideSource(board, args[0]));
  return Math.max(args[1]?.flakeRatchet ? FLAKE_RATCHET_ENGINE : 1, outside ? OUTSIDE_INTAKE_ENGINE : 1, existingEngine(args, board, at));
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "merged", order: 19, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "NOT_VERIFIED": "merge only verified items; see pullboard list --all",
  "FORCED_REASON": 'name why this merge bypassed the gate: pullboard merged <id> <commit> --forced "<why>"'
}) });
