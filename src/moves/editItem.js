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
function minimumEngine(args, board, at) {
  if (args[1]?.reviewFamily !== undefined) return AUTOMATIC_DISPATCH_ENGINE;
  if (args[1]?.correction === true) return AUTOMATIC_DISPATCH_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (board && barReadySetting(board).enabled) return BAR_READY_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  if (carriesBarReason('editItem', args)) return BAR_ENGINE;
  if (args[1] && Object.hasOwn(args[1], 'after') && args[1].after !== undefined) return 10;
  return 1;
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: "editItem", order: 9, engine: 1,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
  "BAD_REVIEW_FAMILY": "use --review-family with a nonempty declared reviewer family of at most 100 characters",
  "BAD_CHECK": "ask your coordinator to set the check: pullboard edit <id> --check \"<command>\"",
  "BAR_REASON": "say what the old bar got wrong: pullboard edit <id> --reason \"...\"",
  "COORDINATOR_CHECK": "ask your coordinator to set the check: pullboard shout coordinator \"please set a check on #<id>\"",
  "USAGE": "run pullboard help"
}) });
