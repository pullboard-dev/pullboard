/** Slug a model label for a prefix display name without changing the stored agent id. */
function modelSlug(model) {
  return String(model || 'unknown').normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f]/gu, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'unknown';
}

/** Show an agent's stable id beside its declared model using the configured naming style. */
export function displayAgentName(agent, style = 'suffix') {
  const id = agent.agent_id ?? agent.id;
  const value = agent.agent_model ?? agent.model;
  const model = typeof value === 'string' && value.trim() ? value.trim() : 'unknown';
  return style === 'prefix' ? `${modelSlug(model)}-${id}` : `${id} (${model})`;
}
