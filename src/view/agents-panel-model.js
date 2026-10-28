/** Select agents and their held work from explicit board observations, without clock or browser reads. */
export function agentsPanelModel({ agents, items, now, activeAgent = null, allAgents = false, idleOpen = false }) {
  const recent = agents.filter(agent => items.some(item => (item.status === 'claimed' && item.holder === agent.agentId)
    || (item.status === 'submitted' && item.reviewer === agent.agentId))
    || (Number.isFinite(now) && agent.lastMoveAt && Number.isFinite(Date.parse(agent.lastMoveAt))
      && now - Date.parse(agent.lastMoveAt) < 36e5));
  const listedAgents = allAgents ? agents : recent;
  const holding = agent => items.filter(item => item.status === 'claimed'
    ? item.holder === agent.agentId
    : item.reviewer === agent.agentId || (item.builtBy === agent.agentId
      && (['back', 'verify'].includes(item.state) || item.stale)))
    .sort((left, right) => {
      const rank = item => item.status === 'claimed' ? 0 : item.reviewer === agent.agentId ? 1
        : item.state === 'back' || item.stale ? 2 : 3;
      return rank(left) - rank(right);
    });
  const listed = listedAgents.map(agent => ({ ...agent, holding: holding(agent) }));
  const busy = listed.filter(agent => agent.holding.length > 0);
  const idle = listed.filter(agent => agent.holding.length === 0);
  const keepIdleOpen = idleOpen || idle.some(agent => agent.agentId === activeAgent);
  return {
    listed,
    busy,
    idle,
    idleOpen: keepIdleOpen,
    activeAgent,
    allAgents,
    totalAgents: agents.length,
    showAll: agents.length > recent.length,
    emptyText: agents.length ? 'No agent has moved today.' : 'No agents yet.',
  };
}
