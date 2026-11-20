import { itemReviewPolicyEngine } from "../../../../verify/browser.js";
import { REVIEW_FAMILY_RELAX_ENGINE } from '../../../../state/light.js';
import { frozenRelaxationEngine } from '../floor.js';
import { requiredReviewFamilyEngine } from "../../../../verify/browser.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by reserveReview, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (args[1]?.familyRelaxAt !== undefined || frozenRelaxationEngine(board, args[0]) > 1) return REVIEW_FAMILY_RELAX_ENGINE;
  if (itemReviewPolicyEngine(board, args[0]) > 1) return Math.max(itemReviewPolicyEngine(board, args[0]), requiredReviewFamilyEngine(board, args[0]));
  if (requiredReviewFamilyEngine(board, args[0]) > 1) return requiredReviewFamilyEngine(board, args[0]);
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 1;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "reserveReview", order: 16, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "REQUIRED_REVIEW_FAMILY": "ask a reviewer whose declared family matches the item review-family requirement",
  "STRICT_REVIEW_TOUCHED": "ask a session that has not written to this strict item",
  "COORDINATOR_VERIFIES": "leave the review to the coordinator; record readiness on the item: pullboard fact <id> note \"ready for coordinator review\"",
  "LINE_SETTING_RANGE": "read the allowed range with pullboard settings line, then record an in-range value or off with its reason and window numbers",
  "MAIN_IS_COORDINATOR": "use an independent agent checkout for agent work, or run person-only actions from the main checkout as the coordinator",
  "MILESTONES_CORRUPT": "restore the board from a known-good export: pullboard import <file>",
  "NOT_JOINED": "join a lane from this worktree: pullboard join <lane> --model \"<model name>\" (see: pullboard lanes)",
  "NOT_SUBMITTED": "see its state with pullboard show <id>; verify only submitted items: pullboard next --verify",
  "NO_ITEM": "find the item id: pullboard list --all",
  "O2_FAMILY_MATCH": "ask the coordinator for a verifier from another family: pullboard shout coordinator --kind question \"#<id> needs a verifier from another family\"",
  "SAME_FAMILY": "ask the coordinator for a verifier from another family: pullboard shout coordinator --kind question \"#<id> needs a verifier from another family\"",
  "REVIEW_COOLDOWN": "take another review: pullboard next --verify",
  "REVIEW_HELD": "take another review: pullboard next --verify",
  "ROUTE": "take an item your route covers: pullboard next",
  "LOW_STAKES_FORGED": "the rows sent do not match what the item froze at its claim: ask a different agent to verify it, as for SELF_VERIFY",
  "SELF_SESSION_VERIFY": "start the review in a separate process or session: run pullboard next --verify from a different agent session's own worktree",
  "SELF_VERIFY": "ask a different agent to verify it; from main create its worktree with pullboard worktree <lane> --model \"<model name>\"",
  "SESSION_LEDGER": "make the agent-session ledger named in the message writable by this user, then run the command again",
  "VERIFIER_STANDING": "ask the coordinator to make an independent verifier from the main checkout: pullboard worktree <lane> --model \"<model name>\""
}) });
