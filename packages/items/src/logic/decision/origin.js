/**
 * Where a decision came from: its statement, rationale, who decided, who relayed it and its origin [N29,B29,P6].
 *
 * The record lives in the answer's own event, so no schema changes. Only the board decides the person
 * origin: a real person answer carries it, and no caller can name it, so an agent's word is never shown
 * as the person's (P6). A decision with no recorded origin reads as unknown, never as the person's.
 */
import { DECISION_ORIGIN_ENGINE } from '../../../../state/light.js';
import { ENGINE_VERSION } from '../../../../state/light.js';
import { Refused } from "../../../../kernel/browser.js";

/** The origins an agent may name; `person` is reserved for a real person answer. */
export const NAMEABLE_ORIGINS = Object.freeze(['person-relayed', 'agent', 'inherited']);

/**
 * True when an answer move carries this engine's meaning, so older engines refuse it.
 *
 * @param {any[]} args the sealed move arguments
 * @returns {boolean}
 */
export function carriesOrigin(args) {
  const options = args?.[1];
  return Boolean(options && typeof options === 'object' && (options.origin !== undefined || options.rationale !== undefined));
}

/**
 * Build the provenance an answer records, or null on a board replaying an older engine.
 *
 * @param {any} board
 * @param {{ agentId: string, asPerson: boolean, text: string, origin?: string, rationale?: string }} answer
 * @returns {{ statement: string, rationale: string, decidedBy: string, relayedBy: string | null, origin: string } | null}
 */
export function answerProvenance(board, { agentId, asPerson, text, origin, rationale }) {
  const engine = board.executionEngineVersion ?? ENGINE_VERSION;
  const named = origin !== undefined && origin !== null;
  const reason = String(rationale ?? '').trim();
  if (engine < DECISION_ORIGIN_ENGINE) {
    if (named || reason) throw new Refused('ENGINE_VERSION', `recording an origin or a rationale requires engine ${DECISION_ORIGIN_ENGINE}; this board uses engine ${engine}; upgrade Pullboard first`);
    return null;
  }
  if (named && !NAMEABLE_ORIGINS.includes(origin)) {
    throw new Refused('BAD_ORIGIN', `an origin is ${NAMEABLE_ORIGINS.join(', ')}, not "${origin}"; only a real person answer is the person's origin: pullboard answer <id> <text> --origin person-relayed`);
  }
  if (asPerson && named) throw new Refused('BAD_ORIGIN', 'a person answer is its own origin; leave out --origin');
  const chosen = asPerson ? 'person' : (origin ?? 'agent');
  const decidedBy = asPerson ? 'person' : chosen === 'agent' ? agentId : 'unknown';
  return { statement: String(text).trim(), rationale: reason, decidedBy, relayedBy: ['person-relayed', 'inherited'].includes(chosen) ? agentId : null, origin: chosen };
}
