/** The landing tables wired to the landing cell's own limits, fault codes and repeat-hold prefix, so callers and replays share one source [C7,#8249]. */
import { LANDING_FAULT_CODES } from '../../../../store/index.js';
import { LANDING_RED_LIMIT } from '../../../../store/index.js';
import { REPEATED_LANDING_HOLD } from '../../../../store/index.js';
import { RUNNER_SOURCE_RETRIES } from '../../../../store/index.js';
import { landingEngine } from '../../logic/table/landing.table.js';

/** Unheld items behind a full batch that selection still projects for staleness, as the landing's selection walk does. */
const STALE_PROBES = 8;

/**
 * The landing rules and tables over the landing's `LANDING_RED_LIMIT`, `RUNNER_SOURCE_RETRIES`, `LANDING_FAULT_CODES` and `REPEATED_LANDING_HOLD`.
 * Why: the pure tables take all four by injection; this is the one place that hands them the live ones.
 *
 * @returns {ReturnType<typeof landingEngine>}
 */
export function boardLandingEngine() {
  return landingEngine({ limits: { redLimit: LANDING_RED_LIMIT, runnerSourceRetries: RUNNER_SOURCE_RETRIES, staleProbes: STALE_PROBES }, faultCodes: LANDING_FAULT_CODES, repeatHold: REPEATED_LANDING_HOLD });
}
