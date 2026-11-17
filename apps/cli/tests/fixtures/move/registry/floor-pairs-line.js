/** Pair floor check 3/3: the trigger table for setLineSetting's setting keys [C7,V4,H16,#9672]. */
import {
  BAR_CHECK_ENGINE,
  BOARD_SENTINEL_ENGINE,
  FOCUS_BOUNDARY_ENGINE,
  FOCUS_MILESTONE_ENGINE,
  LAND_COLLISION_ENGINE,
  LANDING_LEASE_ENGINE,
  LINE_ORDER_ENGINE,
  LIVE_ROUTE_ENGINE,
  QUEUE_FAIRNESS_ENGINE,
  REJECT_CLAUSE_ENGINE,
  REJECTION_RETURN_ENGINE,
  REVIEW_INDEPENDENCE_ENGINE,
  REWORK_SAME_FAMILY_ENGINE,
  RIGOR_AUTO_ENGINE,
} from '../../../../../../packages/state/light.js';

/**
 * The table for setLineSetting: every key that raises its floor, then the options that ride beside a key. The keys
 * share one `group` because a call sets exactly one key; the landing fence and the two causes combine with any key.
 */
export const LINE_TABLE = { move: 'setLineSetting', options: [
  { name: 'key collisionFreeBatch', args: [{ key: 'collisionFreeBatch' }, {}], floor: LAND_COLLISION_ENGINE, group: 'key' },
  { name: 'key order', args: [{ key: 'order' }, {}], floor: LINE_ORDER_ENGINE, group: 'key' },
  { name: 'key agingMinutes', args: [{ key: 'agingMinutes' }, {}], floor: QUEUE_FAIRNESS_ENGINE, group: 'key' },
  { name: 'key focusMilestone', args: [{ key: 'focusMilestone' }, {}], floor: FOCUS_MILESTONE_ENGINE, group: 'key' },
  { name: 'key focusMilestone object', args: [{ key: 'focusMilestone', value: {} }, {}], floor: Math.max(FOCUS_BOUNDARY_ENGINE, FOCUS_MILESTONE_ENGINE), group: 'key' },
  { name: 'key bar.check', args: [{ key: 'bar.check' }, {}], floor: BAR_CHECK_ENGINE, group: 'key' },
  { name: 'key bar.sharpenToPerson', args: [{ key: 'bar.sharpenToPerson' }, {}], floor: REJECT_CLAUSE_ENGINE, group: 'key' },
  { name: 'key requireReviewFamilies', args: [{ key: 'requireReviewFamilies' }, {}], floor: REVIEW_INDEPENDENCE_ENGINE, group: 'key' },
  { name: 'key route.liveOnly', args: [{ key: 'route.liveOnly' }, {}], floor: LIVE_ROUTE_ENGINE, group: 'key' },
  { name: 'key returnRejectedWork', args: [{ key: 'returnRejectedWork' }, {}], floor: REJECTION_RETURN_ENGINE, group: 'key' },
  { name: 'key reworkSameFamily', args: [{ key: 'reworkSameFamily' }, {}], floor: REWORK_SAME_FAMILY_ENGINE, group: 'key' },
  { name: 'landingFence', args: [{ landingFence: 1 }, {}], floor: LANDING_LEASE_ENGINE },
  { name: 'cause conflict', args: [{}, { cause: 'conflict:x' }], floor: RIGOR_AUTO_ENGINE, group: 'cause' },
  { name: 'cause sentinel', args: [{}, { cause: 'sentinel:x' }], floor: BOARD_SENTINEL_ENGINE, group: 'cause' },
] };

/** The pairs that fail today, each with the conflict named. Never grows; later slices fix the floors and shrink it. */
export const LINE_ALLOW_LIST = [];
