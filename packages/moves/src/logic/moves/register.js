import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
import { ADVISOR_ROLE_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by register, discovered without a shared registry edit [C7,V4,H16]. */
import { VERIFIER_STANDING_ENGINE } from "../../../../state/light.js";
import { NEEDS_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { createHash } from 'node:crypto';
import { familyDeclareFloor } from "../../../../items/browser.js";

/** Hex SHA-256 of UTF-8 text: the port the pure family floor hashes a raw session with. */
function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function historicalMinimum(args) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 1;
}

/**
 * The historical floor, raised on every branch by the activated family floor: after a modern prefix, a fresh
 * older-engine rejoin of a declared seat would skip the declared-family rule whatever cause or fence it carries.
 */
function minimumEngine(args, board, at) {
  return Math.max(historicalMinimum(args), args[0]?.role === undefined ? 1 : ADVISOR_ROLE_ENGINE, args[0]?.abilities === undefined ? 1 : NEEDS_ENGINE, familyDeclareFloor(board, args[0], sha256));
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.engine >= VERIFIER_STANDING_ENGINE ? (move.args[0]?.createdBy === 'machine' ? null : move.args[0]?.createdBy ?? null) : null; }

export default Object.freeze({ operation: "register", order: 6, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "ALREADY_JOINED": "create a worktree for the other lane: pullboard worktree <lane> --model \"<model name>\", then work from the path it prints",
  "BAD_ROLE": "use --role advisor, or leave --role off for an ordinary seat",
  "BAD_ROUTE": "use --route light, mid or strong",
  "FAMILY_DECLARED": "keep the declared family; to review as another vendor, create a fresh worktree: pullboard worktree <lane> --family <vendor> --model \"<model name>\"",
  "NO_AGENT": "create and join a lane worktree: pullboard worktree <lane> --model \"<model name>\"",
  "ONE_COORDINATOR": "make a lane worktree and join it as an agent: pullboard worktree <lane> --model \"<model name>\""
}) });
