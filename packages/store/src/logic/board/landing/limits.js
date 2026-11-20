/** The landing's pure limits, fault codes and repeat-hold prefix, below the landing cell so the move tables and the landing share one source [C7,#8249]. */
import { TRANSIENT_CODES } from '../../../../../kernel/light.js';

/** How many landing batches in a row may end red for one item at one commit before it returns to its builder. */
export const LANDING_RED_LIMIT = 3;

/** Automatic landing retries a RUNNER_SOURCE refusal at most this many times before holding the item. */
export const RUNNER_SOURCE_RETRIES = 3;

/** Prefix for automatic holds created after the same landing cause blocks two batches. */
export const REPEATED_LANDING_HOLD = 'landing-repeat-v1:';

/**
 * Refusals that say the landing's machinery could not run, not that the batch or an item failed: a busy board, a locked
 * slot database, accepted policy that moved mid-write (#5672), or a gate whose only non-green shards are runner refusals.
 * They are retried and never park an item.
 * Why here: the repeat guard (core) and the landing steps (shell) must judge the same codes [C7,#3693].
 */
export const LANDING_FAULT_CODES = Object.freeze([...TRANSIENT_CODES]);
