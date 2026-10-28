/** Routing owned by setRoutingRule; a rule is coordinator-set data next reads [C7,H16]. */
import { ROUTING_RULES_ENGINE } from '../routing-rules-engine.js';
/** The record has no historical interpretation. */
function minimumEngine() { return ROUTING_RULES_ENGINE; }
/** Credential selection uses the exact native options actor. */
function actor(move) { return move.args[0]?.agentId ?? null; }
export default Object.freeze({ operation: 'setRoutingRule', order: 10020, engine: ROUTING_RULES_ENGINE,
  itemIdFirstArgument: false, minimumEngine, actor,
  nextSteps: Object.freeze({
    BAD_ROUTING_RULE: 'record a rule with pullboard rule add review|build|any <effect> <value> --item <id> --source <shout-id>',
    NO_ROUTING_RULE: 'list the rules with pullboard rule list',
    ROUTING_RULE: 'take work no rule bars you from: pullboard next'
  }) });
