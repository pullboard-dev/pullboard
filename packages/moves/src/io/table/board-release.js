/** The release table wired to the board's own reason list and stale limits, so callers and replays share one source [C7,#8240]. */
import { RELEASE_REASONS } from '../../../../store/index.js';
import { staleStateLimits } from '../../../../store/index.js';
import { RELEASE_TWICE_ENGINE } from '../../../../state/light.js';
import { REVIEW_RELEASE_TWICE_ENGINE } from '../../../../state/light.js';
import { releaseEngine } from '../../logic/table/release.table.js';

/**
 * The release rules and table over the store's `RELEASE_REASONS` and `staleStateLimits`.
 * Why: the pure table takes both by injection; this is the one place that hands it the live ones.
 *
 * @returns {{ rules: Readonly<Record<string, object>>, table: Readonly<object> }}
 */
export function boardReleaseEngine() {
  return releaseEngine({ reasons: RELEASE_REASONS, staleLimits: staleStateLimits, releaseTwiceEngine: RELEASE_TWICE_ENGINE, reviewReleaseTwiceEngine: REVIEW_RELEASE_TWICE_ENGINE });
}
