import { checkTimingEngine } from "../../../../items/browser.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by refreeze, discovered without a shared registry edit [C7,V4,H16]. */
import { BAR_READY_ENGINE } from "../../../../state/light.js";
import { barReadySetting } from "../bar/ready.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (board && barReadySetting(board).enabled) return BAR_READY_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 1;
}

/** Preserve prior replay floors while protecting a timing-sensitive frozen bar. */
function minimumEngine(args, board, at) {
  return Math.max(checkTimingEngine(board, args[0]), existingEngine(args, board, at));
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "refreeze", order: 21, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "A5_GRAMMAR_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "AGENT_APPROVAL_REQUIRED": "ask the person to confirm or decline the named row through pullboard view or their own terminal",
  "BAD_CONFIG": "fix pullboard.json as the message says, then commit it: git commit -m \"chore: fix pullboard config\" pullboard.json",
  "BAR_EMPTY": "ask the coordinator to give the item numbered clauses: pullboard edit <id> --criterion \"1. ... [test]\" --reason \"...\"",
  "BAR_NOT_READY": "read pullboard bar <id>; ask its author to complete the named red baseline and measurement/edge notes, then have an outside parent session sign the current bar",
  "CLOSED": "read its state with pullboard show <id>, then take open work: pullboard next",
  "COORDINATOR_ONLY": "ask the coordinator to do it: pullboard shout coordinator --kind question \"<what you need>\"",
  "NOT_JOINED": "join a lane from this worktree: pullboard join <lane> --model \"<model name>\" (see: pullboard lanes)",
  "NOT_YOURS": "shout its holder or the coordinator: pullboard shout coordinator --kind question \"<what you need>\"",
  "NO_ITEM": "find the item id: pullboard list --all",
  "NO_POLICY": "restore and commit pullboard.json, then run the command again",
  "SESSION_LEDGER": "make the agent-session ledger named in the message writable by this user, then run the command again",
  "UNKNOWN_SPEC": "ask the coordinator to restore the named spec rows or withdraw the item: pullboard shout coordinator --kind question \"please fix the rows cited by #<id>\""
}) });
