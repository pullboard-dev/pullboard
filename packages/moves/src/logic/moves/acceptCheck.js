import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by acceptCheck, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { CHECK_ACCEPT_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return CHECK_ACCEPT_ENGINE;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "acceptCheck", order: 47, engine: CHECK_ACCEPT_ENGINE,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "B26_PERSON_CHANNEL": "record it as the person through pullboard view or the person's own terminal",
  "CHECK_ACCEPT_PERSON_ONLY": "ask the coordinator to bring the check to the person: pullboard shout coordinator --kind question \"#<id> needs the person to accept its check\" --decision",
  "CHECK_ACCEPT_STALE": "read the current check with pullboard show <id>, then the person accepts it again: pullboard check accept <id>",
  "NO_CHECK": "run the project gate: pullboard gate"
}) });
