/** Recording a routing rule: the board-writing half, kept apart from the pure reads the move descriptors import [C7,H16]. */
import { atomic } from './board.js';
import { logEvent } from './board.js';
import { ENGINE_VERSION } from './machine.js';
import { ROUTING_RULES_ENGINE } from './routing-rules-engine.js';
import { ROUTING_RULES_KEY as KEY } from './routing-rules-floor.js';
import { routingRules } from './routing-rules.js';
import { validRule } from './routing-rules.js';
import { STANDING_RULINGS } from './routing-rules.js';
import { Refused } from './refused.js';
export { routingRules } from './routing-rules.js';

/** Older recorded moves keep their meaning: no rule binds under an engine that predates the record. */
function enabled(board) { return (board.executionEngineVersion ?? ENGINE_VERSION) >= ROUTING_RULES_ENGINE; }

/** Record or revoke one rule; only the coordinator sets them, and an identical rule is recorded once. */
export function setRoutingRule(board, options) {
  if (board.executionEngineVersion !== undefined && !enabled(board)) throw new Refused('ENGINE_VERSION', `routing rules require engine ${ROUTING_RULES_ENGINE}`);
  if (options?.agentId !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'only the coordinator sets routing rules');
  return atomic(board, () => {
    const rules = routingRules(board);
    const save = next => board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES(?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
      .run(KEY, JSON.stringify(next));
    if (options.revoke !== undefined) {
      if (!rules.some(rule => rule.id === options.revoke)) throw new Refused('NO_ROUTING_RULE', `no routing rule #${options.revoke}; list them with pullboard rule list`);
      save(rules.filter(rule => rule.id !== options.revoke));
      logEvent(board, 'coordinator', 'routing-rule', null, { revoke: options.revoke });
      return options.revoke;
    }
    const { act, scope, effect, value, source = null, note } = options;
    const rule = { act, scope, effect, value: typeof value === 'string' ? value.trim() : value, source, ...(note === undefined ? {} : { note }) };
    const refusal = validRule(rule);
    if (refusal) throw refusal;
    const same = rules.find(found => JSON.stringify({ ...found, id: undefined }) === JSON.stringify({ ...rule, id: undefined }));
    if (same) return same.id;
    const id = rules.reduce((top, found) => Math.max(top, found.id), 0) + 1;
    save([...rules, { id, ...rule }]);
    logEvent(board, 'coordinator', 'routing-rule', null, { rule: { id, ...rule } });
    return id;
  });
}

/** Record every standing ruling not already a rule; running it twice records nothing new. */
export function migrateStandingRulings(board, agentId) {
  return STANDING_RULINGS.map(ruling => setRoutingRule(board, { agentId, ...ruling }));
}

