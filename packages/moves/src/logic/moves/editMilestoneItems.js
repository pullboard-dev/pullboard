import { MILESTONE_LIMIT_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by editMilestoneItems, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { MILESTONE_PLACEMENT_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (args[1]?.reason !== undefined) return MILESTONE_PLACEMENT_ENGINE;
  if (Array.isArray(args[1]?.swap) && args[1].swap.length > 0) return MILESTONE_LIMIT_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 1;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "editMilestoneItems", order: 31, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "MILESTONE_LIMIT": "remove or swap an unstarted item, or edit the milestone with --limit <n>|none",
  "MILESTONE_ITEMS": "list item ids once each: pullboard milestone add <name> --items 1,2",
  "NO_MILESTONE": "name a milestone from pullboard roadmap",
  "MILESTONE_PLACED": "leave the board's placement, or override it: pullboard milestone items <name> --add <id> --reason \"<why>\""
}) });
