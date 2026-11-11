/**
 * The instant a target the coordinator typed names, read in this machine's time zone, as UTC ISO
 * text, or `none` unchanged. The move is prepared with this value, so the ordered envelope never
 * carries a local time that another replica would read in its own zone.
 *
 * @param {unknown} target
 * @returns {unknown}
 */
export function canonicalMilestoneTarget(target) {
  if (target === 'none' || typeof target !== 'string' || !/\d/.test(target)) return target;
  const at = Date.parse(target.trim());
  return Number.isFinite(at) ? new Date(at).toISOString() : target;
}

