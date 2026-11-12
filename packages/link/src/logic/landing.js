/** Keep physical landing authority out of optimistic local or queued relay fallbacks [Q1,H16]. */
import { Refused } from '../../../kernel/light.js';

/** Preserve ordinary move fallbacks while requiring acknowledged order for fenced landing work. */
export function landingRelayCallbacks(operation, args, { apply, queue }) {
  const authority = operation === 'landingLeaseMove' || args?.[0]?.landingFence !== undefined;
  /** A local preview is never a grant to start physical landing work. */
  const applyConfirmed = () => {
    if (authority) throw new Refused('LAND_RELAY_REQUIRED', 'a linked landing lease needs an acknowledged relay order; restore the relay connection before landing');
    return apply();
  };
  return {
    apply: applyConfirmed,
    /** Landing authority cannot be manufactured by queuing an unacknowledged move. */
    queue(error, move) {
      if (authority) throw error;
      return queue(error, move, applyConfirmed);
    },
  };
}
