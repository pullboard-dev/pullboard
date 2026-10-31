import { RIGOR_AUTO_ENGINE } from "../../../../../src/rigor-auto-engine.js";
/** Routing metadata owned by shipMilestone, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../../src/landing-lease-engine.js";
import { MILESTONE_SHIP_ENGINE } from "../../../../../src/move-engine-constants.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../../src/sentinel-engine.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return MILESTONE_SHIP_ENGINE;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "shipMilestone", order: 36, engine: MILESTONE_SHIP_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "REFERENCES_MISSING": "add every named acknowledgement to the selected release section in CHANGELOG.md, commit it on main, then run pullboard milestone ship <name> before tagging",
  "MILESTONE_LIMIT": "remove or swap an unstarted item, or edit the milestone with --limit <n>|none",
  "MILESTONE_COMMIT": "commit to main, then ship from the main checkout: pullboard milestone ship <name>",
  "MILESTONE_ORDER": "move it before a different milestone; see pullboard roadmap",
  "NO_MILESTONE": "name a milestone from pullboard roadmap",
  "NO_NEXT_MILESTONE": "add the next milestone, or name one: pullboard milestone ship <name> --next <milestone>"
}) });
