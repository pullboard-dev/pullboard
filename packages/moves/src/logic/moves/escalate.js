import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by escalate, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 1;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "escalate", order: 11, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "CLOSED": "read its state with pullboard show <id>, then take open work: pullboard next",
  "NOTE_REQUIRED": "add --note \"<what happened>\"",
  "NOT_JOINED": "join a lane from this worktree: pullboard join <lane> --model \"<model name>\" (see: pullboard lanes)",
  "NOT_YOURS": "shout its holder or the coordinator: pullboard shout coordinator --kind question \"<what you need>\"",
  "NO_ITEM": "find the item id: pullboard list --all",
  "SESSION_LEDGER": "make the agent-session ledger named in the message writable by this user, then run the command again"
}) });
