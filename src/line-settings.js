import { REJECT_CLAUSE_ENGINE } from './reject-clause-engine.js';
/** Recorded controller inputs, not machine capacity or active queue enforcement [R1,R2,H16]. */
import { atomic } from './board.js';
import { logEvent } from './board-event-log.js';
import {
  validateLineSetting,
} from './queue-settings.js';
import { FOCUS_MILESTONE_ENGINE } from './focus-milestone-engine.js';
import { LINE_ORDER_ENGINE } from './line-order-engine.js';
import { LINE_SETTINGS_ENGINE } from './line-settings-engine.js';
import { LAND_COLLISION_ENGINE } from './landing-collision-engine.js';
import { Refused } from './refused.js';
import { REVIEW_INDEPENDENCE_ENGINE } from './review-independence-engine.js';
import { LIVE_ROUTE_ENGINE } from './live-route-engine.js';

const PREFIX = 'line_setting:';

export { lineSettings } from './line-settings-read.js';

/** Keep the triggering window as finite numeric observations; null retains an explicitly unknown measurement. */
function windowNumbers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length
    || Object.entries(value).some(([key, number]) => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key)
      || number !== null && (typeof number !== 'number' || !Number.isFinite(number) || number < 0))) {
    throw new Refused('LINE_SETTING_WINDOW', 'include a nonempty JSON window of named nonnegative finite numbers (or null for unknown), for example --window \'{"windowMinutes":60,"activeReviewers":2}\'');
  }
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

/** Change one board input atomically with its reason and measured window, so ordered replay makes the same event. */
export function setLineSetting(board, { agentId, key, value, reason, window } = {}) {
  if (agentId !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'ask the coordinator to record a line setting with its reason and window numbers');
  const required = key === 'bar.sharpenToPerson' ? REJECT_CLAUSE_ENGINE : key === 'requireReviewFamilies' ? REVIEW_INDEPENDENCE_ENGINE : key === 'route.liveOnly' ? LIVE_ROUTE_ENGINE : key === 'focusMilestone' ? FOCUS_MILESTONE_ENGINE : key === 'collisionFreeBatch' ? LAND_COLLISION_ENGINE : key === 'order' ? LINE_ORDER_ENGINE : LINE_SETTINGS_ENGINE;
  if ((board.executionEngineVersion ?? required) < required) throw new Refused('ENGINE_VERSION', 'upgrade Pullboard before recording or replaying board line settings');
  validateLineSetting(key, value);
  if (typeof reason !== 'string' || !reason.trim()) throw new Refused('LINE_SETTING_REASON', 'give the reason for this change with --reason "what the measured window shows"');
  const change = { key, value, reason: reason.trim(), window: windowNumbers(window) };
  return atomic(board, () => {
    board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
      .run(PREFIX + key, JSON.stringify(value));
    logEvent(board, agentId, 'line_setting', null, change);
    return change;
  });
}
