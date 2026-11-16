import { EXPECTED_BUILD_ENGINE } from '../../../../state/light.js';
import { BLOCKED_DEPENDENCIES_ENGINE } from '../../../../state/light.js';
import { localDependencyIds } from '../../../../seats/browser.js';
import { REJECTION_RETURN_ENGINE } from '../../../../state/light.js';
import { PIPELINE_CAUSE_ENGINE } from "../../../../state/light.js";
import { EXIT_RULES_ENGINE } from "../../../../state/light.js";
import { checkTimingEngine } from "../../../../items/browser.js";
import { CROSS_REPO_DEPENDENCY_ENGINE } from "../../../../state/light.js";
import { SUBMIT_ADMISSION_ENGINE } from "../../../../state/light.js";
import { hasForeignDependencies } from "../../../../items/browser.js";
import { AUTOMATIC_DISPATCH_ENGINE } from "../../../../state/light.js";
import { LINE_CAPACITY_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by claim, discovered without a shared registry edit [C7,V4,H16]. */
import { BAR_READY_ENGINE } from "../../../../state/light.js";
import { barReadySetting } from "../bar/ready.js";
import { firstRefusal } from "../../../../store/browser.js";
import { REOPEN_FIRST_REFUSAL_ENGINE } from "../../../../state/light.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { OUTSIDE_INTAKE_ENGINE } from "../../../../state/light.js";
import { outsideSource } from "../../../../items/browser.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { ITEM_FOLDER_ENGINE } from "../../../../state/light.js";
import { REWORK_SAME_FAMILY_ENGINE } from "../../../../state/light.js";
import { CLAIM_NEXT } from "../table/next.js";

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  // Renewals issued by the gate retain modern multi-claim semantics even without the CLI flag.
  if (board && args[1]?.agentId && board.db.prepare(`SELECT 1 FROM item i JOIN event e ON e.item_id=i.item_id
    WHERE i.item_owner=? AND i.item_status='claimed' AND e.event_kind='claim' AND e.event_by=i.item_owner
      AND e.event_id=(SELECT MAX(last.event_id) FROM event last WHERE last.item_id=i.item_id AND last.event_kind='claim')
      AND json_valid(e.event_detail) AND json_extract(e.event_detail,'$.itemFolder')=1 LIMIT 1`).get(args[1].agentId)) return ITEM_FOLDER_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (board && barReadySetting(board).enabled) return BAR_READY_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (board && firstRefusal(board, args[0], at)) return REOPEN_FIRST_REFUSAL_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return 1;
}
/** Keep outside-source isolation as the original maximum over the older engine rule. */
function minimumEngine(args, board, at) {
  const outside = board && Boolean(outsideSource(board, args[0]));
  const capacity = args[1]?.lineCapacity === true;
  const id = args[0];
  const validId = ['number', 'string'].includes(typeof id) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
  const item = board && validId ? board.db.prepare('SELECT item_after FROM item WHERE item_id=?').get(id) : null;
  const foreign = item && hasForeignDependencies(item);
  const withdrawn = item && localDependencyIds(item).some(dependency => board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(dependency)?.item_status === 'withdrawn');
  const expected = board && validId && board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`item_expected_build_minutes:${id}`);
  return Math.max(expected || args[1]?.buildBudgetMinutes !== undefined ? EXPECTED_BUILD_ENGINE : 1, withdrawn ? BLOCKED_DEPENDENCIES_ENGINE : 1, args[1]?.returnRejectedWork === true ? REJECTION_RETURN_ENGINE : 1, args[1]?.submitOutcome != null ? PIPELINE_CAUSE_ENGINE : 1, args[1]?.exitRules?.enabled === true ? EXIT_RULES_ENGINE : 1, checkTimingEngine(board, args[0]), args[1]?.reworkSameFamily === true ? REWORK_SAME_FAMILY_ENGINE : 1, args[1]?.itemFolder === true ? ITEM_FOLDER_ENGINE : 1, args[1]?.adoptCorrection === true || args[1]?.refreshPolicy === true ? AUTOMATIC_DISPATCH_ENGINE : 1, args[1]?.submitAdmission != null ? SUBMIT_ADMISSION_ENGINE : 1,
    foreign ? CROSS_REPO_DEPENDENCY_ENGINE : 1, outside ? OUTSIDE_INTAKE_ENGINE : 1, capacity ? LINE_CAPACITY_ENGINE : 1, existingEngine(args, board, at));
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "claim", order: 13, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "LINE_WIP_LIMIT": CLAIM_NEXT.LINE_WIP_LIMIT,
  "A5_GRAMMAR_VERSION": CLAIM_NEXT.A5_GRAMMAR_VERSION,
  "AGENT_APPROVAL_REQUIRED": CLAIM_NEXT.AGENT_APPROVAL_REQUIRED,
  "BAD_CONFIG": CLAIM_NEXT.BAD_CONFIG,
  "BAR_EMPTY": CLAIM_NEXT.BAR_EMPTY,
  "BAR_NOT_READY": CLAIM_NEXT.BAR_NOT_READY,
  "BLOCKED": CLAIM_NEXT.BLOCKED,
  "CRITERION_PROVES_NOTHING": CLAIM_NEXT.CRITERION_PROVES_NOTHING,
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "HELD": CLAIM_NEXT.HELD,
  "ITEM_LEASE_LOST": "read pullboard show <id>; if the item is free, claim it again for a build or reserve it with pullboard next --verify <id> for a review, then retry",
  "ITEM_HELD": CLAIM_NEXT.ITEM_HELD,
  "LANE_HELD": CLAIM_NEXT.LANE_HELD,
  "NOT_CLAIMABLE": CLAIM_NEXT.NOT_CLAIMABLE,
  "NOT_JOINED": CLAIM_NEXT.NOT_JOINED,
  "NO_ITEM": CLAIM_NEXT.NO_ITEM,
  "NO_POLICY": CLAIM_NEXT.NO_POLICY,
  "ONE_CLAIM": CLAIM_NEXT.ONE_CLAIM,
  "PENDING_REFREEZE": CLAIM_NEXT.PENDING_REFREEZE,
  "REOPEN_HELD_FOR_BUILDER": CLAIM_NEXT.REOPEN_HELD_FOR_BUILDER,
  "ROUTE": CLAIM_NEXT.ROUTE,
  "SESSION_LEDGER": CLAIM_NEXT.SESSION_LEDGER,
  "UNKNOWN_SPEC": CLAIM_NEXT.UNKNOWN_SPEC,
  "WRONG_LANE": CLAIM_NEXT.WRONG_LANE
}) });
