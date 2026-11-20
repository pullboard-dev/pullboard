import { EXPECTED_BUILD_ENGINE } from '../../../../state/light.js';
import { READINESS_ENGINE } from '../../../../state/light.js';
import { NEEDS_ENGINE } from '../../../../state/light.js';
import { CHECK_TIMING_ENGINE } from "../../../../state/light.js";
import { REVIEW_INDEPENDENCE_ENGINE } from "../../../../state/light.js";
import { REFERENCE_ENGINE } from "../../../../state/light.js";
import { CROSS_REPO_DEPENDENCY_ENGINE } from "../../../../state/light.js";
import { hasForeignDependencies } from "../../../../items/browser.js";
import { AUTOMATIC_DISPATCH_ENGINE } from "../../../../state/light.js";
import { RIGOR_AUTO_ENGINE } from "../../../../state/light.js";
/** Routing metadata owned by addItem, discovered without a shared registry edit [C7,V4,H16]. */
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

/** Preserve every historical floor while preventing older replicas from flattening foreign references. */
function minimumEngine(args, board, at) {
  return Math.max(args[0]?.expectedBuildMinutes !== undefined ? EXPECTED_BUILD_ENGINE : 1, args[0]?.readinessCommand !== undefined ? READINESS_ENGINE : 1, args[0]?.needs !== undefined ? NEEDS_ENGINE : 1, args[0]?.checkTiming !== undefined ? CHECK_TIMING_ENGINE : 1, (args[0]?.sensitive !== undefined || (args[0]?.reviewFamily !== undefined && args[0]?.reviewFamily === null)) ? REVIEW_INDEPENDENCE_ENGINE : 1, (args[0]?.referenceAuthors !== undefined || args[0]?.referenceAuthority !== undefined) ? REFERENCE_ENGINE : 1,
    existingEngine(args, board, at), hasForeignDependencies(args[0]?.after) ? CROSS_REPO_DEPENDENCY_ENGINE : 1,
    args[0]?.reviewFamily !== undefined ? AUTOMATIC_DISPATCH_ENGINE : 1);
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.by ?? null; }

export default Object.freeze({ operation: "addItem", order: 8, engine: 1,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "BAD_REVIEW_POLICY": 'restore the native review policy before reviewing this item',
  "REFERENCE_AUTHOR": "use the issue or pull request author's handle, or remove the handle from its Reference line, then add or edit the item again",
  "REFERENCE_IS_BOARD": "use --specs for spec rows, --after for item dependencies, or --parent for a parent item",
  "BAD_REVIEW_FAMILY": "use --review-family with a nonempty declared reviewer family of at most 100 characters",
  "BAD_CHECK": "ask your coordinator to set the check: pullboard edit <id> --check \"<command>\"",
  "BAD_CHECK_BASELINE": "the coordinator sets the check again: pullboard edit <id> --check \"<command>\"",
  "CHECK_RUNS_PULLBOARD_TEST": "run the files directly: node packages/gate/src/io/run/tests.js <files>",
  "COORDINATOR_CHECK": "ask your coordinator to set the check: pullboard shout coordinator --kind question \"please set a check on #<id>\"",
  "ACCEPTED_RECORD_UNKNOWN": "accept the record again with pullboard contribute accept <file>, then add with the hash it prints",
  "ACCEPTED_RECORD_NO_TITLE": "name the title: pullboard add <lane> \"<title>\" --from-record <hash>"
}) });
