import { REJECTION_RETURN_ENGINE } from '../../../../state/light.js';
import { QUARANTINE_VERDICT_ENGINE } from "../../../../state/light.js";
import { SOURCE_ADVANCE_ENGINE } from "../../../../state/light.js";
import { MECHANICAL_MERGE_ENGINE } from "../../../../state/light.js";
import { GENERATED_DOCS_ENGINE } from "../../../../state/light.js";
import { PLAN_MERGE_ENGINE } from "../../../../state/light.js";
import { AGENT_GRANT_ENGINE } from "../../../../state/light.js";
import { VERDICT_WITHDRAW_ENGINE } from "../../../../state/light.js";
import { MERGE_ONLY_VERDICT_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by reopen, discovered without a shared registry edit [C7,V4,H16]. */
import { itemById } from "../../../../store/browser.js";
import {
  CAUSE_ENGINE,
  QUOTED_LANDING_FAILURE_ENGINE,
  REOPEN_FIRST_REFUSAL_ENGINE,
  SUBMITTED_CONFLICT_ENGINE,
} from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { CONFLICT_ENGINE } from "../../../../state/light.js";
import { carriesConflict } from "../../../../merge/browser.js";
import { REOPEN_NEXT } from "../table/next.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  const quotedLandingFailureEngine = args[1]?.quotedLandingFailure === true ? QUOTED_LANDING_FAILURE_ENGINE : 1;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return Math.max(RIGOR_AUTO_ENGINE, quotedLandingFailureEngine);
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (args[1]?.reopenFirstRefusalMinutes !== undefined) return Math.max(REOPEN_FIRST_REFUSAL_ENGINE, quotedLandingFailureEngine);
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return Math.max(BOARD_SENTINEL_ENGINE, quotedLandingFailureEngine);
  if (carriesConflict('reopen', args)) return Math.max(board && itemById(board, args[0])?.item_status === 'submitted' ? SUBMITTED_CONFLICT_ENGINE : CONFLICT_ENGINE, quotedLandingFailureEngine);
  if (['cause', 'neverAgain', 'asPerson'].some(name => Boolean(args[1] && typeof args[1] === 'object' && Object.hasOwn(args[1], name) && args[1][name] !== undefined && args[1][name] !== null && args[1][name] !== false))) return Math.max(CAUSE_ENGINE, quotedLandingFailureEngine);
  return Math.max(8, quotedLandingFailureEngine);
}

/** Keep verdict withdrawal as an independent maximum over every prior first-match floor [H16]. */
function minimumEngine(args, board, at) {
  const carried = board && board.db.prepare("SELECT 1 FROM item i JOIN event e ON e.item_id = i.item_id WHERE i.item_id = ? AND e.event_kind = 'merge-only-accept' AND json_extract(e.event_detail,'$.commit') = i.item_commit LIMIT 1").get(args[0]);
  return Math.max(args[1]?.returnRejectedWork === true ? REJECTION_RETURN_ENGINE : 1, args[1]?.sourceAdvanceReturn?.phases?.some(phase => Object.hasOwn(phase.receipt ?? {}, 'blockingVerdict')) ? QUARANTINE_VERDICT_ENGINE : 1, args[1]?.sourceAdvanceReturn !== undefined ? SOURCE_ADVANCE_ENGINE : 1, args[1]?.computedConflict?.version === 4 ? PLAN_MERGE_ENGINE : 1,
    args[1]?.computedConflict?.version === 3 ? GENERATED_DOCS_ENGINE : 1,
    args[1]?.computedConflict?.version === 2 ? MECHANICAL_MERGE_ENGINE : 1,
    carried ? MERGE_ONLY_VERDICT_ENGINE : 1,
    args[1]?.computedConflict !== undefined ? AGENT_GRANT_ENGINE : 1,
    args[1]?.withdrawVerdict === true ? VERDICT_WITHDRAW_ENGINE : 1, existingEngine(args, board, at));
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "reopen", order: 22, engine: 8,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: REOPEN_NEXT });
