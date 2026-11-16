/** The claim table wired to the grant engine the board stamps on every claim, so callers and replays share one source [C7,#8241]. */
import { AGENT_GRANT_ENGINE } from '../../../../state/light.js';
import { claimEngine } from '../../logic/table/claim.table.js';

/**
 * The claim rules and table over state's `AGENT_GRANT_ENGINE`.
 * Why: the pure table takes the engine by injection; this is the one place that hands it the live one.
 *
 * @returns {{ rules: Readonly<Record<string, object>>, table: Readonly<object> }}
 */
export function boardClaimEngine() {
  return claimEngine({ grantEngine: AGENT_GRANT_ENGINE });
}
