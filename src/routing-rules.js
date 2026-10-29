/** Routing rulings as data: who may review or build an item is a coordinator-set board record, never prose [C7,H16]. */
import { ENGINE_VERSION } from './engine-metadata.js';
import { ROUTING_RULES_ENGINE } from './routing-rules-engine.js';
import { ROUTING_RULES_KEY } from './routing-rules-floor.js';
import { familyAliasesOf } from './review-policy.js';
import { familyName } from './review-policy.js';
import { itemReviewPolicy } from './review-policy.js';
import { effectiveAgentParent } from './seat-review-read.js';
import { seatFamily } from './family-declaration.js';
import { Refused } from './refused.js';

export const ROUTING_ACTS = Object.freeze(['review', 'build', 'any']);
export const ROUTING_EFFECTS = Object.freeze(['only-seat', 'bar-seat', 'require-family', 'bar-family', 'bar-pool', 'require-session', 'bar-session', 'different-session', 'different-family']);
export { RELEASE_REASONS, releaseReasonProblem } from './release-reasons.js';
const KEY = ROUTING_RULES_KEY;

/** Standing prose rulings, migrated verbatim in meaning; each names the shout it came from [32288, 42630, 43048]. */
export const STANDING_RULINGS = Object.freeze([
  { act: 'review', scope: { all: true }, effect: 'different-session', value: 'builder', source: 32288,
    note: 'standing until revoked: reviews need a different session from the builder' },
  { act: 'review', scope: { tier: 'strict' }, effect: 'different-family', value: 'builder', source: 32288,
    note: 'standing until revoked: strict reviews also need a different declared vendor family, for any builder vendor' },
  { act: 'review', scope: { item: 1641 }, effect: 'only-seat', value: 'core-731', source: 42630,
    note: 'view-215 releases it; core-731 reviews #1641' },
  { act: 'review', scope: { item: 1669 }, effect: 'require-family', value: 'claude', source: 43048,
    note: 'release it; it goes to a Claude reviewer' },
]);

/** Every rule recorded on this board, in the order the coordinator set them. */
export function routingRules(board) {
  const text = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(KEY)?.meta_value;
  return text ? JSON.parse(text) : [];
}

/** Older recorded moves keep their meaning: no rule binds under an engine that predates the record. */
function enabled(board) { return (board.executionEngineVersion ?? ENGINE_VERSION) >= ROUTING_RULES_ENGINE; }

/** Validate one rule's closed shape before it is recorded. */
export function validRule(rule) {
  const scope = rule?.scope;
  const bad = (why) => new Refused('BAD_ROUTING_RULE', `${why}; a rule is: rule add review|build|any <effect> <value> --item <id>|--tier strict|--all --source <shout-id>, effect one of ${ROUTING_EFFECTS.join(', ')}`);
  if (!ROUTING_ACTS.includes(rule.act)) return bad('act is review, build or any');
  if (!ROUTING_EFFECTS.includes(rule.effect)) return bad('unknown effect');
  if (typeof rule.value !== 'string' || !rule.value.trim() || rule.value.length > 100 || /[\u0000-\u001f\u007f]/u.test(rule.value)) return bad('value names one seat, family or pool');
  const itemScope = Number.isSafeInteger(scope?.item) && scope.item > 0 && Object.keys(scope).length === 1;
  const tierScope = scope?.tier === 'strict' && Object.keys(scope).length === 1;
  const allScope = scope?.all === true && Object.keys(scope).length === 1;
  if (!itemScope && !tierScope && !allScope) return bad('scope is one item id, the strict tier, or all items');
  if (['different-session', 'different-family'].includes(rule.effect) && (rule.act !== 'review' || rule.value !== 'builder')) return bad('different-session and different-family compare a reviewer to builder');
  if (rule.source !== null && !(Number.isSafeInteger(rule.source) && rule.source > 0)) return bad('source is the shout id the ruling came from');
  if (rule.note !== undefined && (typeof rule.note !== 'string' || rule.note.length > 400)) return bad('note is at most 400 characters');
  return null;
}

/** Does this rule speak to the item for this act? A tier rule reads the item's native review tier. */
function applies(board, rule, item, act) {
  if (rule.act !== 'any' && rule.act !== act) return false;
  return rule.scope.all === true || (rule.scope.item !== undefined ? rule.scope.item === item.item_id : itemReviewPolicy(board, item.item_id).tier === 'strict');
}

/** Read the persisted session itself; a shared parent is a separate routing dimension. */
function recordedSession(board, agentId) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`agent_session:${agentId}`)?.meta_value ?? null;
}

/** The first recorded rule barring this seat from this act on this item, as a refusal naming the rule and its source shout. */
export function routingRuleProblem(board, item, agentId, act) {
  if (!enabled(board)) return null;
  const rules = routingRules(board);
  if (!rules.length) return null;
  const aliases = familyAliasesOf(board);
  const family = familyName(seatFamily(board, agentId), aliases);
  const pool = effectiveAgentParent(board, agentId), session = recordedSession(board, agentId);
  for (const rule of rules) {
    if (!applies(board, rule, item, act)) continue;
    const named = familyName(rule.value, aliases) ?? rule.value.toLowerCase();
    const builderSession = rule.effect === 'different-session' ? recordedSession(board, item.item_built_by) : null;
    const builderFamily = rule.effect === 'different-family' ? familyName(seatFamily(board, item.item_built_by), aliases) : null;
    const barred = rule.effect === 'different-session' ? !session || !builderSession || session === builderSession
      : rule.effect === 'different-family' ? !family || !builderFamily || family === builderFamily
      : rule.effect === 'only-seat' ? agentId !== rule.value
      : rule.effect === 'bar-seat' ? agentId === rule.value
        : rule.effect === 'require-family' ? family !== named
          : rule.effect === 'bar-family' ? family === named
            : rule.effect === 'bar-session' ? !session || session === rule.value
              : rule.effect === 'require-session' ? !session || session !== rule.value
                : agentId === rule.value || pool === rule.value || pool === `seat:${rule.value}`;
    if (barred) return new Refused('ROUTING_RULE', `routing rule #${rule.id}${rule.source ? ` (shout ${rule.source})` : ''} bars you from the ${act} of #${item.item_id}: ${rule.effect} ${rule.value}`);
  }
  return null;
}
