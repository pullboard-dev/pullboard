/** Return a landing-reopened item to verified on its own accept, without a new build or review [C7,V4,H16]. */
import { ACCEPTED_RELAND_ENGINE } from '../../../../state/light.js';

/** The move exists only from its own engine onward [C7,H16]. */
function minimumEngine() { return ACCEPTED_RELAND_ENGINE; }

/** Attribute the move to the landing coordinator that ran it [C7,H16]. */
function actor(move) { return move.args[1]?.agentId ?? null; }

export default Object.freeze({ operation: 'relandAccepted', engine: ACCEPTED_RELAND_ENGINE,
  itemIdFirstArgument: true, minimumEngine, actor,
  nextSteps: Object.freeze({
    RELAND_NOT_ELIGIBLE: 'read pullboard show <id>; only an open item a landing reopened, with its accept and green gate at its head, returns without review',
    BAD_RELAND: 'pass the trunk commit and the sorted conflicting paths Git reported for the item head',
  }) });
