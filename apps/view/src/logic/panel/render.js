/** Render prepared agents-panel data as HTML; labels, avatars, chips, titles and ages are caller-prepared. */
export function agentsPanelHtml(panel) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const state = (agent, item, brief = false) => brief ? item.briefStateHtml : item.stateHtml;
  const row = agent => {
    const first = agent.holding[0];
    const more = agent.holding.length - 1;
    const tip = agent.tipHtml + (more ? ' · +' + more + ' more ' + (more === 1 ? 'item' : 'items') : '');
    return '<div class="agent-card' + agent.markClasses + '"><button class="agent-row" data-agent="' + esc(agent.agentId) + '" title="' + tip + '" type="button">'
      + '<span class="agent-who"><b>' + agent.nameHtml + '</b><span class="agent-model">' + (agent.modelHtml || '') + '</span></span>'
      + '<span class="agent-state">' + (first.ageHtml || agent.ageHtml) + state(agent, first, true) + '</span>'
      + '<span class="agent-doing"><span class="agent-what"><i>#' + first.id + '</i> ' + first.titleTextHtml + '</span></span></button>'
      + (panel.activeAgent === agent.agentId ? agent.holding.map(item => '<div class="agent-work" data-item="' + item.id + '" data-go="item:' + item.id + '"><span>#' + item.id + ' ' + item.titleHtml + '</span>' + state(agent, item) + '</div>').join('') : '') + '</div>';
  };
  const pill = agent => '<button class="agent-pill' + agent.markClasses + '" data-agent="' + esc(agent.agentId) + '" title="' + agent.tipHtml + '" type="button"><span>' + agent.nameHtml + '</span></button>';
  const allAgents = panel.showAll ? '<button class="link all-agents" data-all-agents type="button" title="' + esc(panel.allAgents ? 'Show only agents with work' : 'All ' + panel.totalAgents + ' agents recorded by the board') + '">' + (panel.allAgents ? 'show only agents at work' : 'show all ' + panel.totalAgents) + '</button>' : '';
  const idleBlock = !panel.idle.length ? allAgents : '<div class="agents-idle"><button class="fold-line" data-fold="idle" type="button" aria-expanded="' + Boolean(panel.idleOpen) + '" title="' + esc(panel.idle.map(agent => agent.name).join(', ')) + '"><span>' + esc(panel.idle.length + ' idle') + '</span><span class="fold-more">' + (panel.idleOpen ? 'hide' : 'show') + '</span></button>'
    + (panel.idleOpen ? '<div class="idle-list">' + panel.idle.map(pill).join('') + '</div>' + allAgents : '') + '</div>';
  return panel.listed.length ? panel.busy.map(row).join('') + idleBlock
    : '<div class="empty">' + panel.emptyText + '</div>';
}
