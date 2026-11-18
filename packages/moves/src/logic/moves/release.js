import { TWO_TIER_DIAGNOSIS_ENGINE } from '../../../../state/light.js';
import { BLOCKED_DEPENDENCIES_ENGINE } from '../../../../state/light.js';
import { TAKEN_OVER_RELEASE_ENGINE } from '../../../../state/light.js';
import { EXIT_RULES_ENGINE } from "../../../../state/light.js";
import { LEASE_LAPSE_ENGINE } from "../../../../state/light.js";
import { RELEASE_TWICE_HOLD_ENGINE } from "../../../../state/light.js";
import { RELEASE_REASONS_ENGINE } from "../../../../state/light.js";
import { REVIEW_RELEASE_REASON_ENGINE } from "../../../../state/light.js";
import { STALE_STATE_ENGINE } from "../../../../state/light.js";
import { GONE_CLAIM_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by release, discovered without a shared registry edit [C7,V4,H16]. */
import { firstRefusal } from "../../../../store/browser.js";
import { REOPEN_FIRST_REFUSAL_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { RELEASE_NEXT } from "../table/next.js";

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
  return Math.max(args[4] === 'DIAGNOSIS_WRONG' || args[3] === 'DIAGNOSIS_WRONG' ? TWO_TIER_DIAGNOSIS_ENGINE : 1, args[4] === 'TAKEN_OVER' || args[3] === 'TAKEN_OVER' ? TAKEN_OVER_RELEASE_ENGINE : 1, args[3]?.blockedOn !== undefined ? BLOCKED_DEPENDENCIES_ENGINE : 1, args[4] !== undefined || typeof args[3] === 'string' ? RELEASE_TWICE_HOLD_ENGINE : 1, board && board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='claim' AND event_detail LIKE '%\"exitRules\"%' LIMIT 1").get(args[0]) ? EXIT_RULES_ENGINE : 1, args[4] !== undefined ? RELEASE_REASONS_ENGINE : 1, typeof args[3] === 'string' ? RELEASE_REASONS_ENGINE : args[3]?.leaseLapse === true ? LEASE_LAPSE_ENGINE : args[3]?.staleClaim !== undefined ? STALE_STATE_ENGINE : args[3] !== undefined ? GONE_CLAIM_ENGINE : 1, ['BAR', 'FAMILY', 'TOO_LARGE'].includes(args[4]) ? REVIEW_RELEASE_REASON_ENGINE : 1, existingEngine(args, board, at));
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1] ?? null; }

export default Object.freeze({ operation: "release", order: 14, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "BAD_CONFIG": "fix pullboard.json as the message says, then commit it: git commit -m \"chore: fix pullboard config\" pullboard.json",
  ...RELEASE_NEXT,
  "SESSION_LEDGER": "make the agent-session ledger named in the message writable by this user, then run the command again"
}) });
