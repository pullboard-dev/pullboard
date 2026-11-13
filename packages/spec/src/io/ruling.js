/** Current request advice uses native row sources; historical events retain declarations, not stale ownership [D1,N26]. */
import { rowDecisionContext } from './row/stale.js';
import { Refused } from '../../../kernel/light.js';
import { rulingOwner } from '../logic/ruling.js';
export { RULING_EFFECT_OPERATIONS, normalizeRulingEffects, rulingOwner } from '../logic/ruling.js';

/** Resolve qualified row identities from one current spec/doctrine snapshot without accepting caller statuses. */
export function rulingRowReader(root, config) {
  const context = rowDecisionContext(root, config);
  return reference => {
    const doctrine = reference.startsWith('doctrine:');
    const row = context(doctrine ? 'doctrine' : 'spec', doctrine ? reference.slice('doctrine:'.length) : reference);
    return row.count === 1 ? row.row : null;
  };
}

/** Recompute visible advice from current governing rows; missing or changed rows never silently become agent-owned. */
export function projectRulingOwners(asks, { root, config }) {
  let readRow;
  return asks.map(ask => {
    if (ask.effects === undefined) return ask;
    readRow ??= rulingRowReader(root, config);
    try { return { ...ask, ruling: rulingOwner(ask.effects, { readRow }) }; }
    catch (error) {
      if (!(error instanceof Refused)) throw error;
      return { ...ask, ruling: { owner: null, code: error.code, message: error.message } };
    }
  });
}
