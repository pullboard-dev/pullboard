import { MILESTONE_LIMIT_ENGINE } from "../../../../state/light.js";
import { MILESTONE_PERSON_LIMIT_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by editMilestone, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { MILESTONE_SHIP_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (args[1]?.limit !== undefined) return args[1].asPerson === true ? MILESTONE_PERSON_LIMIT_ENGINE : MILESTONE_LIMIT_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  if (args[1] && Object.hasOwn(args[1], 'target') && args[1].target !== undefined) return MILESTONE_SHIP_ENGINE;
  return 1;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "editMilestone", order: 34, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "MILESTONE_LIMIT_PERSON": "ask the person to raise it: pullboard milestone edit <name> --limit <n>|none --as person, run in the main checkout",
  "MILESTONE_LIMIT": "remove or swap an unstarted item, or edit the milestone with --limit <n>|none",
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "MILESTONE_EDIT": "pass --name, --note or --target: pullboard milestone edit <name> --note \"<text>\"",
  "MILESTONE_EXISTS": "pick another name, or edit the existing one: pullboard milestone edit <name>",
  "NO_MILESTONE": "name a milestone from pullboard roadmap"
}) });
