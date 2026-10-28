/** Compact native view projections; detailed proof accounting remains available on demand [N26,A2]. */

/** Keep flow aggregates without transmitting a proof record for every historical item. */
export function viewFlowSummary(flow) {
  if (!flow?.report) return flow;
  const { items: _items, ...report } = flow.report;
  return { ...flow, report };
}

/** Keep the totals and grouped summaries consumed by the view, leaving detailed CLI stats intact. */
export function viewProofSummary(stats) {
  const { agents: _agents, bars: _bars, caught: _caught, ...summary } = stats;
  return { ...summary, flow: viewFlowSummary(stats.flow) };
}

/** Match the existing four-hour Dashboard activity window, retaining every field of each recently active seat. */
export function activeViewAgents(agents, now) {
  return agents.filter(agent => {
    const at = Date.parse(agent.lastMoveAt);
    return Number.isFinite(at) && at <= now && at >= now - 4 * 3_600_000;
  });
}
