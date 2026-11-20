/** The claim-time verdict on a check's measured time: ok, or refused when it is over the frozen ceiling or unmeasured under a strict check [C7]. */
import { Refused } from '../../../kernel/light.js';

/**
 * Compare a check's measured time to its ceiling.
 * Why a pending remeasure passes: an old check carries no trustworthy measurement until the background baseline re-measures it, so it is never refused for that gap.
 * Why strict refuses a missing time: a strict check promises a measurement, and a verdict without one would pass unproven work.
 *
 * @param {{ measuredMs?: number | null, ceilingMs: number, remeasurePending?: boolean, strict?: boolean }} input
 * @returns {{ ok: true }}
 * @throws {Refused} CHECK_OVER_CEILING when measuredMs is over ceilingMs; CHECK_UNSOUND when strict and measuredMs is missing.
 */
export function checkVerdict({ measuredMs, ceilingMs, remeasurePending = false, strict = false }) {
  if (remeasurePending && !strict) return { ok: true };
  const measured = typeof measuredMs === 'number' && Number.isFinite(measuredMs);
  if (!measured) {
    if (strict) throw new Refused('CHECK_UNSOUND', 'a strict check needs a measured time; re-measure it with the check baseline, then claim again');
    return { ok: true };
  }
  if (measuredMs > ceilingMs) throw new Refused('CHECK_OVER_CEILING', `the check measured ${measuredMs} ms, over its ${ceilingMs} ms ceiling; cut the check or ask the coordinator to re-bar it`);
  return { ok: true };
}
