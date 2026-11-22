/** Build the stable read summary before any candidate-specific review guards run. */
export function reviewEligibilitySummary({ tier, requiredFamily, ready, strictOnly = false, strictOwnerFallback = null }) {
  const summary = { tier, requiredFamily, ready, eligible: [], ineligible: [] };
  if (strictOwnerFallback) summary.owner = strictOwnerFallback.owner;
  return { summary, candidatesReady: ready && !(strictOnly && tier !== 'strict') };
}
