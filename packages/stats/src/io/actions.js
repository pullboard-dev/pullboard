import { Refused } from '../../../kernel/index.js';
import { coordinatorActionRise } from '../logic/actions.js';
/** Read coordinator evidence from native SQLite without replaying unrelated events [B35,R2]. */
import { coordinatorActionStats } from '../logic/actions.js';

/** Use the native clock by default and retain older merge receipts solely to deduplicate first landings. */
export function coordinatorActions(board, { since, until = board.clock.now().toISOString(), pending = [] } = {}) {
  since ??= new Date(Date.parse(until) - 86_400_000).toISOString();
  const history = board.db.prepare(`SELECT event_at,event_kind,event_by,item_id,event_detail FROM event
    WHERE event_kind='merged' OR (event_by='coordinator' AND event_at>=? AND event_at<=?) ORDER BY event_id`).all(since, until);
  return coordinatorActionStats([...history, ...pending], { since, until });
}

/** Read the last measured project release from the shared native log, retaining it across host changes. */
export function previousCoordinatorMilestone(board) {
  const event = board.db.prepare(`SELECT event_detail FROM event WHERE event_kind='milestone_ship'
    AND json_type(event_detail,'$.coordinatorActions.gauge.perLanding') IN ('integer','real') ORDER BY event_id DESC LIMIT 1`).get();
  return event ? JSON.parse(event.event_detail) : null;
}

/** Enforce the project release ratchet inside the same transaction that ships its milestone. */
export function coordinatorMilestoneRelease(board, { asPerson = false, reason, channel = 'terminal', plannedMoves = [] } = {}) {
  if (asPerson !== false && asPerson !== true || asPerson && (!['terminal', 'view'].includes(channel)
    || typeof reason !== 'string' || !reason.trim() || reason.length > 1000) || !asPerson && reason !== undefined) {
    throw new Refused('USAGE', 'a person override needs --as person --reason "why" from the primary checkout');
  }
  const previous = previousCoordinatorMilestone(board);
  const until = board.clock.now().toISOString();
  const pending = plannedMoves.map(event_kind => ({ event_kind, event_at: until, event_by: 'coordinator', item_id: null, event_detail: '{}' }));
  const gauge = coordinatorActions(board, { until, pending });
  const problem = coordinatorActionRise(gauge, previous?.coordinatorActions.gauge);
  if (problem && !asPerson) throw new Refused('COORDINATOR_ACTIONS_ROSE', `${problem}; reduce the actions or have the person ship with --as person --reason "why"`);
  return { gauge, previous: previous?.name ?? null, problem, ...(asPerson ? { override: { by: 'person', reason: reason.trim(), channel } } : {}) };
}
