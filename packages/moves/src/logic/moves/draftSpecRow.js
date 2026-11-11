import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by draftSpecRow, discovered without a shared registry edit [C7,V4,H16]. */
import { ROW_DRAFT_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { SPEC_REVISION_ENGINE } from "../../../../state/light.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function minimumEngine(args, board, at) {
  if (args[0]?.row?.revises !== undefined) return Math.max(SPEC_REVISION_ENGINE, ROW_DRAFT_ENGINE,
    args[0]?.landingFence === undefined ? 0 : LANDING_LEASE_ENGINE,
    typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:') ? RIGOR_AUTO_ENGINE : 0,
    typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:') ? BOARD_SENTINEL_ENGINE : 0);
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return ROW_DRAFT_ENGINE;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "draftSpecRow", order: 39, engine: ROW_DRAFT_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "ROW_DRAFT": "pullboard spec draft \"<text>\" from an agent seat; the person approves the returned id"
}) });
