/** One ordered transaction retains each usage record's existing validation and idempotency [N2,H16]. */
import { listAgents } from './board-query.js';
import { atomic } from './board-event-log.js';
import { recordUsage } from './cost.js';
import { recordSharedUsage } from './cost-shared.js';
import { ENGINE_VERSION } from './engine-metadata.js';
import { USAGE_BATCH_ENGINE } from './usage-batch-engine.js';
import { Refused } from './refused.js';

/** Publish only the authenticated seat's revisions; any invalid record rolls back the entire batch. */
export function recordUsageBatch(board, { agentId, items = [], sharedSessions = [] }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < USAGE_BATCH_ENGINE) throw new Refused('ENGINE_VERSION', `usage batching requires engine ${USAGE_BATCH_ENGINE}`);
  if (!listAgents(board).some(value => value.agent_id === agentId)) throw new Refused('NOT_JOINED', 'join before publishing a usage batch');
  if (!Array.isArray(items) || !Array.isArray(sharedSessions) || items.length + sharedSessions.length > 1000
      || items.some(value => !value || value.agentId !== agentId)
      || sharedSessions.some(value => !value || value.agentId !== undefined && value.agentId !== agentId)) {
    throw new Refused('USAGE_RECORD', 'a usage batch carries at most 1000 revisions belonging to its authenticated seat');
  }
  return atomic(board, () => ({
    items: items.map(value => recordUsage(board, value)),
    sharedSessions: sharedSessions.map(value => recordSharedUsage(board, { ...value, agentId })),
  }));
}
