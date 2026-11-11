import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by signBar, discovered without a shared registry edit [C7,V4,H16]. */
import { BAR_READY_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  return BAR_READY_ENGINE;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "signBar", order: 5, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "BAR_NOT_READY": "read pullboard bar <id>; ask its author to complete the named red baseline and measurement/edge notes, then have an outside parent session sign the current bar",
  "BAR_PARENT_UNKNOWN": "join a fresh worktree from the current native session with its real parent; an outside session must sign a bar whose author identities are known",
  "BAR_SELF_SIGN": "ask a different parent session to review the current bar and run pullboard bar sign <id> --note \"...\"",
  "BAR_SIGN_STALE": "read pullboard show <id> and pullboard bar <id> again, then sign the current revision with current coverage evidence",
  "CLOSED": "read its state with pullboard show <id>, then take open work: pullboard next",
  "NOTE_REQUIRED": "add --note \"<what happened>\""
}) });
