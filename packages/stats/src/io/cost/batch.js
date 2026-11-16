/** One ordered transaction retains each usage record's existing validation and idempotency [N2,H16]. */
import { USAGE_BATCH_LIMIT } from './usage.js';
import { recordUsage } from '../cost.js';
import { recordSharedUsage } from './shared.js';
import { ENGINE_VERSION } from '../../../../state/light.js';
import { USAGE_BATCH_ENGINE } from '../../../../state/light.js';
import { Refused } from '../../../../kernel/light.js';

/** Publish only the authenticated seat's revisions; any invalid record rolls back the entire batch. */
export function recordUsageBatch(board, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => !['agentId', 'items', 'sharedSessions'].includes(key))) {
    throw new Refused('USAGE_RECORD', 'a usage batch carries only its actor and numeric revisions');
  }
  const { agentId, items = [], sharedSessions = [] } = payload;
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < USAGE_BATCH_ENGINE) throw new Refused('ENGINE_VERSION', `usage batching requires engine ${USAGE_BATCH_ENGINE}`);
  if (!board.db.prepare('SELECT 1 FROM agent WHERE agent_id=? LIMIT 1').get(agentId)) throw new Refused('NOT_JOINED', 'join before publishing a usage batch');
  if (!Array.isArray(items) || !Array.isArray(sharedSessions) || items.length + sharedSessions.length > USAGE_BATCH_LIMIT
      || items.some(value => !value || value.agentId !== agentId
        || Object.keys(value).some(key => !['agentId', 'item', 'revision', 'records', 'observedAt', 'shared'].includes(key)))
      || sharedSessions.some(value => !value || value.agentId !== undefined && value.agentId !== agentId
        || Object.keys(value).some(key => !['agentId', 'id', 'seats', 'allocations', 'revision', 'observedAt', 'records'].includes(key)))) {
    throw new Refused('USAGE_RECORD', 'a usage batch carries at most 1000 revisions belonging to its authenticated seat');
  }
  return board.nativePorts.atomic(board, () => ({
    items: items.map(value => recordUsage(board, value)),
    sharedSessions: sharedSessions.map(value => recordSharedUsage(board, { ...value, agentId })),
  }));
}
