import { READINESS_ENGINE } from '../../../../state/light.js';
import { NEEDS_ENGINE } from '../../../../state/light.js';
import { EXPECTED_BUILD_ENGINE } from '../../../../state/light.js';
import { MACHINE_VERDICT_ENGINE } from '../../../../state/light.js';
import { BLOCKED_DEPENDENCIES_ENGINE } from '../../../../state/light.js';
import { checkTimingEngine } from "../../../../items/browser.js";
import { REVIEW_TIER_ENGINE } from "../../../../state/light.js";
import { CHECK_TIMING_ENGINE } from "../../../../state/light.js";
import { REVIEW_INDEPENDENCE_ENGINE } from "../../../../state/light.js";
import { REFERENCE_ENGINE } from "../../../../state/light.js";
import { CROSS_REPO_DEPENDENCY_ENGINE } from "../../../../state/light.js";
import { hasForeignDependencies } from "../../../../items/browser.js";
import { AUTOMATIC_DISPATCH_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by editItem, discovered without a shared registry edit [C7,V4,H16]. */
import {
  carriesBarReason,
} from "../../../../verify/browser.js";
import { BAR_ENGINE } from "../../../../state/light.js";
import { BAR_READY_ENGINE } from "../../../../state/light.js";
import { barReadySetting } from "../bar/ready.js";
import { LANDING_LEASE_ENGINE } from "../../../../state/light.js";
import { BOARD_SENTINEL_ENGINE } from "../../../../state/light.js";
import { PER_ITEM_FULL_SUITE_ENGINE } from '../../../../state/light.js';

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function existingEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (board && barReadySetting(board).enabled) return BAR_READY_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  if (carriesBarReason('editItem', args)) return BAR_ENGINE;
  if (args[1] && Object.hasOwn(args[1], 'after') && args[1].after !== undefined) return 10;
  return 1;
}

/** Preserve every historical floor while preventing older replicas from flattening foreign references. */
function minimumEngine(args, board, at) {
  const blockedWait = args[1]?.after !== undefined && board?.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`blocked_release_waiting:${args[0]}`);
  const floor = Math.max(args[1]?.machineVerified !== undefined || args[1]?.machineCommands !== undefined || args[1]?.machineReceipts !== undefined ? MACHINE_VERDICT_ENGINE : 1, args[1]?.expectedBuildMinutes !== undefined ? EXPECTED_BUILD_ENGINE : 1, args[1]?.readinessCommand !== undefined ? READINESS_ENGINE : 1, args[1]?.needs !== undefined ? NEEDS_ENGINE : 1, blockedWait ? BLOCKED_DEPENDENCIES_ENGINE : 1, checkTimingEngine(board, args[0]), args[1]?.checkTiming !== undefined ? CHECK_TIMING_ENGINE : 1, args[1]?.reviewTier !== undefined ? REVIEW_TIER_ENGINE : 1, (args[1]?.sensitive !== undefined || args[1]?.reviewFamily === null) ? REVIEW_INDEPENDENCE_ENGINE : 1, (args[1]?.referenceAuthors !== undefined || args[1]?.referenceAuthority !== undefined) ? REFERENCE_ENGINE : 1,
    existingEngine(args, board, at), hasForeignDependencies(args[1]?.after) ? CROSS_REPO_DEPENDENCY_ENGINE : 1,
    args[1]?.reviewFamily !== undefined || args[1]?.correction === true ? AUTOMATIC_DISPATCH_ENGINE : 1);
  return Math.max(floor, args[1]?.preserveFrozen === true ? PER_ITEM_FULL_SUITE_ENGINE : 1);
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "editItem", order: 9, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "BAD_REVIEW_POLICY": 'restore the native review policy before reviewing this item',
  "REFERENCE_AUTHOR": "use the issue or pull request author's handle, or remove the handle from its Reference line, then add or edit the item again",
  "REFERENCE_IS_BOARD": "use --specs for spec rows, --after for item dependencies, or --parent for a parent item",
  "BAD_REVIEW_FAMILY": "use --review-family with a nonempty declared reviewer family of at most 100 characters",
  "BAD_CHECK": "ask your coordinator to set the check: pullboard edit <id> --check \"<command>\"",
  "BAD_SPECS": "pass a nonempty list of distinct spec row ids: pullboard edit <id> --specs G1,G2 --reason \"...\"",
  "BAR_REASON": "say what the old bar got wrong: pullboard edit <id> --reason \"...\"",
  "CHECK_RUNS_PULLBOARD_TEST": "run the files directly: node packages/gate/src/io/run/tests.js <files>",
  "COORDINATOR_CHECK": "ask your coordinator to set the check: pullboard shout coordinator --kind question \"please set a check on #<id>\"",
  "USAGE": "run pullboard help"
}) });
