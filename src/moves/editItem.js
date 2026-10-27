import { REVIEW_INDEPENDENCE_ENGINE } from '../review-independence-engine.js';
import { REFERENCE_ENGINE } from '../reference-engine.js';
import { CROSS_REPO_DEPENDENCY_ENGINE } from '../cross-repo-dependency-engine.js';
import { hasForeignDependencies } from '../item-dependencies.js';
import { AUTOMATIC_DISPATCH_ENGINE } from '../automatic-dispatch-engine.js';
import { RIGOR_AUTO_ENGINE } from '../rigor-auto-engine.js';
/** Routing metadata owned by editItem, discovered without a shared registry edit [C7,V4,H16]. */
import {
  BAR_ENGINE,
  carriesBarReason,
} from '../bar-corrections.js';
import { BAR_READY_ENGINE } from '../bar-ready-engine.js';
import { barReadySetting } from '../bar-ready-setting.js';
import { LANDING_LEASE_ENGINE } from '../landing-lease-engine.js';
import { BOARD_SENTINEL_ENGINE } from '../sentinel-engine.js';

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
  return Math.max((args[1]?.sensitive !== undefined || args[1]?.reviewFamily === null) ? REVIEW_INDEPENDENCE_ENGINE : 1, (args[1]?.referenceAuthors !== undefined || args[1]?.referenceAuthority !== undefined) ? REFERENCE_ENGINE : 1,
    existingEngine(args, board, at), hasForeignDependencies(args[1]?.after) ? CROSS_REPO_DEPENDENCY_ENGINE : 1,
    args[1]?.reviewFamily !== undefined || args[1]?.correction === true ? AUTOMATIC_DISPATCH_ENGINE : 1);
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
  "BAR_REASON": "say what the old bar got wrong: pullboard edit <id> --reason \"...\"",
  "COORDINATOR_CHECK": "ask your coordinator to set the check: pullboard shout coordinator \"please set a check on #<id>\"",
  "USAGE": "run pullboard help"
}) });
