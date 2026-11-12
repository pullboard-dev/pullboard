import { MILESTONE_PLACEMENT_ENGINE } from '../../../../state/light.js';
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by orderMilestoneItems, discovered without a shared registry edit [C7,V4,H16]. */
import { MILESTONE_RANK_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { WORK_ORDER_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (args[1]?.reason !== undefined && args[1]?.place === undefined) return MILESTONE_PLACEMENT_ENGINE;
  if (args[1]?.place !== undefined) return WORK_ORDER_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return MILESTONE_RANK_ENGINE;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "orderMilestoneItems", order: 32, engine: MILESTONE_RANK_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "COORDINATOR_ONLY": "ask the coordinator to do it: pullboard shout coordinator --kind question \"<what you need>\"",
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "MILESTONE_ITEMS": "list item ids once each: pullboard milestone add <name> --items 1,2",
  "MILESTONE_PLACE": "pin, sink or lift: pullboard milestone pin <name> <ids> --reason \"<why>\"",
  "MILESTONE_REASON": "say why the item moves: pullboard milestone sink <name> <ids> --reason \"<why>\"",
  "NO_AGENT": "create and join a lane worktree: pullboard worktree <lane> --model \"<model name>\"",
  "NO_MILESTONE": "name a milestone from pullboard roadmap"
}) });
