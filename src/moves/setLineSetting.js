import { FOCUS_MILESTONE_ENGINE } from '../focus-milestone-engine.js';
import { LAND_COLLISION_ENGINE } from '../landing-collision-engine.js';
import { RIGOR_AUTO_ENGINE } from '../rigor-auto-engine.js';
/** Routing metadata owned by setLineSetting, discovered without a shared registry edit [C7,V4,H16]. */
import { LANDING_LEASE_ENGINE } from '../landing-lease-engine.js';
import { LINE_ORDER_ENGINE } from '../line-order-engine.js';
import { LINE_SETTINGS_ENGINE } from '../line-settings-engine.js';
import { BOARD_SENTINEL_ENGINE } from '../sentinel-engine.js';
import { BAR_CHECK_ENGINE } from '../bar-check-engine.js';
import { REVIEW_INDEPENDENCE_ENGINE } from '../review-independence-engine.js';
import { LIVE_ROUTE_ENGINE } from '../live-route-engine.js';

/** Preserve this operation's historical first-matching engine conditions [H16]. */
function historicalMinimumEngine(args, board, at) {
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('conflict:')) return RIGOR_AUTO_ENGINE;
  if (args[0]?.key === 'collisionFreeBatch') return LAND_COLLISION_ENGINE;
  if (args[0]?.key === 'order') return LINE_ORDER_ENGINE;
  if (args[0]?.landingFence !== undefined) return LANDING_LEASE_ENGINE;
  if (typeof args[1]?.cause === 'string' && args[1].cause.startsWith('sentinel:')) return BOARD_SENTINEL_ENGINE;
  return LINE_SETTINGS_ENGINE;
}

/** The focus feature composes with every existing conditional floor rather than short-circuiting it. */
function minimumEngine(args, board, at) {
  return Math.max(
    historicalMinimumEngine(args, board, at),
    args[0]?.key === 'focusMilestone' ? FOCUS_MILESTONE_ENGINE : 1,
    args[0]?.key === 'bar.check' ? BAR_CHECK_ENGINE : 1,
    args[0]?.key === 'requireReviewFamilies' ? REVIEW_INDEPENDENCE_ENGINE : args[0]?.key === 'route.liveOnly' ? LIVE_ROUTE_ENGINE : 1,
  );
}

/** Read precisely the actor argument used by this operation [H2,H16]. */
function actor(move) { return move.args[0]?.agentId ?? null; }

export default Object.freeze({ operation: "setLineSetting", order: 53, engine: LINE_SETTINGS_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
  "COORDINATOR_ONLY": "ask the coordinator to do it: pullboard shout coordinator \"<what you need>\"",
  "ENGINE_VERSION": "upgrade Pullboard: npm install -g pullboard@latest",
  "LINE_SETTING_REASON": "repeat the board setting change with --reason describing the measured window"
}) });
