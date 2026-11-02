import { BLOCKED_DEPENDENCIES_ENGINE } from '../../../../../src/blocked-dependencies-engine.js';
import { EXIT_RULES_ENGINE } from "../../../../../src/exit-rules-engine.js";
import { LEASE_LAPSE_ENGINE } from "../../../../../src/lease-lapse-engine.js";
import { RELEASE_TWICE_HOLD_ENGINE } from "../../../../../src/release-twice-hold-engine.js";
import { RELEASE_REASONS_ENGINE } from "../../../../../src/release-reasons-engine.js";
import { STALE_STATE_ENGINE } from "../../../../../src/stale-state-engine.js";
import { GONE_CLAIM_ENGINE } from "../../../../../src/gone-claim-engine.js";
import { RIGOR_AUTO_ENGINE } from "../../../../../src/rigor-auto-engine.js";
/** Routing metadata owned by release, discovered without a shared registry edit [C7,V4,H16]. */
import { firstRefusal } from "../../../../../src/board-item-read.js";
import { REOPEN_FIRST_REFUSAL_ENGINE } from "../../../../../src/engine-metadata.js";
import { LANDING_LEASE_ENGINE } from "../../../../../src/landing-lease-engine.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../../src/sentinel-engine.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (board && firstRefusal(board, args[0], at)) return REOPEN_FIRST_REFUSAL_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 1;
}

/** An observation cannot be silently ignored by an older release implementation. */
function minimumEngine(args, board, at) {
  return Math.max(args[3]?.blockedOn !== undefined ? BLOCKED_DEPENDENCIES_ENGINE : 1, args[4] !== undefined || typeof args[3] === 'string' ? RELEASE_TWICE_HOLD_ENGINE : 1, board && board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='claim' AND event_detail LIKE '%\"exitRules\"%' LIMIT 1").get(args[0]) ? EXIT_RULES_ENGINE : 1, args[4] !== undefined ? RELEASE_REASONS_ENGINE : 1, typeof args[3] === 'string' ? RELEASE_REASONS_ENGINE : args[3]?.leaseLapse === true ? LEASE_LAPSE_ENGINE : args[3]?.staleClaim !== undefined ? STALE_STATE_ENGINE : args[3] !== undefined ? GONE_CLAIM_ENGINE : 1, existingEngine(args, board, at));
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1] ?? null; }

export default Object.freeze({ operation: "release", order: 14, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "BAD_CONFIG": "fix pullboard.json as the message says, then commit it: git commit -m \"chore: fix pullboard config\" pullboard.json",
  "RELEASE_REASON": "name why with --reason INELIGIBLE|ROUTED_ELSEWHERE|BLOCKED|BUDGET|OTHER (OTHER also needs --note)",
  "NOTE_REQUIRED": "add --note \"<what happened>\"",
  "NOT_JOINED": "join a lane from this worktree: pullboard join <lane> --model \"<model name>\" (see: pullboard lanes)",
  "NOT_YOURS": "shout its holder or the coordinator: pullboard shout coordinator --kind question \"<what you need>\"",
  "NO_ITEM": "find the item id: pullboard list --all",
  "SESSION_LEDGER": "make the agent-session ledger named in the message writable by this user, then run the command again"
}) });
