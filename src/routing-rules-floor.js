/** The engine floor a recorded routing rule imposes; pure, so move descriptors may import it [C7,H16]. */
import { ROUTING_RULES_ENGINE } from './routing-rules-engine.js';

/** The board_meta key holding the rule list. */
export const ROUTING_RULES_KEY = 'routing_rules';

/** A committed routing prefix retains its protocol floor even after its last rule is revoked. */
export function routingRulesEngine(board) {
  const text = board?.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(ROUTING_RULES_KEY)?.meta_value;
  return text !== undefined ? ROUTING_RULES_ENGINE : 1;
}
