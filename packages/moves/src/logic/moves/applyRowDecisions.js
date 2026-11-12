import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
import { AUTOMATIC_DISPATCH_ENGINE } from "../../../../state/light.js";
import { SPEC_DRAFT_REFREEZE_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by applyRowDecisions, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { SPEC_REVISION_ENGINE } from "../../../../state/light.js";
import { rowDecisions } from "../../../../spec/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  let minimum = 1;
  if (board?.db && Array.isArray(args[0]?.events) && rowDecisions(board).some(record => record.revision && args[0].events.includes(record.event))) {
    minimum = Math.max(SPEC_REVISION_ENGINE, args[0]?.landingFence === undefined ? 0 : LANDING_LEASE_ENGINE,
      typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:') ? RIGOR_AUTO_ENGINE : 0,
      typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:') ? BOARD_SENTINEL_ENGINE : 0);
  } else if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) minimum = RIGOR_AUTO_ENGINE;
  else if (args[0]?.landingFence !== undefined) minimum = LANDING_LEASE_ENGINE;
  else if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) minimum = BOARD_SENTINEL_ENGINE;
  if (Object.hasOwn(args[0] ?? {}, 'skippedDrafts')) minimum = Math.max(minimum, SPEC_DRAFT_REFREEZE_ENGINE);
  return Object.hasOwn(args[0] ?? {}, 'refreezes')
    ? Math.max(minimum, AUTOMATIC_DISPATCH_ENGINE)
    : minimum;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "applyRowDecisions", order: 38, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "COORDINATOR_ONLY": "ask the coordinator to do it: pullboard shout coordinator --kind question \"<what you need>\"",
  "ROW_DECISION": "pullboard spec approve <ids>, or pullboard spec decline <ids>",
  "STALE_ROW_DECISION": "ask the person to approve the current row again in pullboard view"
}) });
