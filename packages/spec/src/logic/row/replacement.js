/** Preserve a row's gate, signer list and other fields while changing only its decided status and text [S1,E22]. */
export function rowDecisionReplacement(source, decision, text) {
  const status = decision === 'approve' ? 'approved' : 'wont';
  return source.replace(/\[([a-z]+)(,\s*[a-z]+)?\]/u, (_, old, tier = '') => `[${status}${tier}]`)
    .replace(/(\]\s+)([^|]*)(?=\s*\||$)/u, (_, prefix, old) => `${prefix}${text}${old.match(/\s+$/u)?.[0] ?? ''}`);
}

export function personNeeds(state) {
  /** Keep visible agent names identical to the page without depending on its runtime. */
  const name = (id) => {
    const agent = state.agents?.find(entry => entry.agent_id === id);
    return agent?.displayName || (agent ? `${id} (${agent.model || agent.agent_model || 'unknown'})` : id);
  };
  /**
   * Blocks only the person can clear, one row per rule and command with its plain reason and step,
   * newest first. Inside personNeeds because the page carries this function's source [C6].
   */
  const personBlocks = (blocks) => {
    const found = new Map();
    for (const block of blocks) {
      if (block.audience !== 'person') continue;
      const key = `${block.code} ${block.command}`;
      found.set(key, { kind: 'block', id: `block:${key}`, ref: 'blocked', count: (found.get(key)?.count ?? 0) + 1, at: block.at,
        text: `Pullboard stopped a request that only you can clear: ${block.reason}`, what: block.step });
    }
    return [...found.values()].sort((a, b) => b.at.localeCompare(a.at));
  };
  const rows = (state.spec ?? []).filter(row => !row.decision);
  // Coordinator preparation remains in rigorDrafts; only an existing row is a person call.
  const rigorDrafts = (state.rigorDrafts ?? []).filter(draft => draft.unproved !== true || draft.materialized === true && !draft.collision);
  const drafts = rows.filter(row => (row.status === 'draft' || row.staleDecision) && !rigorDrafts.some(draft => draft.target === `spec:${row.id}`)).length;
  const focus = state.focusMilestone;
  const focusItems = (state.items ?? []).filter(item => focus?.items?.includes(item.id) && !item.merged && item.status !== 'withdrawn');
  const focusRows = ['spec', 'practice'].flatMap(key => (state[key] ?? [])
    .filter(row => row.status === 'draft' && !row.decision)
    .map(row => ({ id: row.id, kind: key === 'practice' ? 'doctrine' : 'spec', text: row.text,
      items: focusItems.filter(item => item.specs?.includes(row.id)).map(item => item.id) }))
    .filter(row => row.items.length));
  return [
    ...(focusRows.length ? [{ kind: 'focus-approval-batch', id: `focus-approval:${focus.name}`, ref: focus.name,
      text: `Draft rows blocking ${focus.name} need your approval.`, rows: focusRows }] : []),
    ...(state.decisions ?? []).map(ask => ({ kind: 'decision', id: ask.shout_id,
      ref: name(ask.shout_from), text: ask.shout_text, what: 'decision', at: ask.shout_at })),
    ...rows.filter(row => row.status === 'pending').map(row => ({ kind: 'pending', id: row.id,
      ref: row.id, text: row.text, what: `pullboard spec answer ${row.id} "<choice>"` })),
    ...(state.holds ?? []).map(hold => ({ kind: 'hold', id: hold.hold_lane,
      ref: hold.hold_lane, text: hold.hold_reason, what: 'lane held by ' + name(hold.hold_by) })),
    ...rigorDrafts,
    ...(state.specRevisions ?? []).map(revision => ({ kind: 'spec-revision', id: revision.id,
      ref: `${revision.id} revises ${revision.revises}`, text: `${revision.reason}\nOld: ${revision.source}\nNew: ${revision.replacement}`,
      old: revision.old, proposed: revision.proposed, source: revision.source, replacement: revision.replacement,
      reason: revision.reason, what: revision.decision === 'approve' ? 'approved; pending spec apply' : 'approve or decline revision',
      target: `spec-revision:${revision.id}`, actions: revision.decision ? [] : [
        { verb: 'spec-approve', args: { ids: revision.id } }, { verb: 'spec-decline', args: { ids: revision.id } }] })),
    ...(state.sentinelDrafts ?? []),
    ...(state.spec ?? []).filter(row => row.agentApproval && row.agentApproval.mode !== 'allow' && row.decision?.decision !== 'decline').map(row => ({ kind: 'agent-approved', id: row.id,
      ref: row.id, agent: row.agentApproval.agent, commit: row.agentApproval.commit, approvedAt: row.agentApproval.approvedAt ?? null, attribution: row.agentApproval.attribution,
      text: `${row.id} is agent-approved; ${row.agentApproval.attribution}: ${row.agentApproval.agent}; commit ${row.agentApproval.commit ?? 'not committed'}`,
      what: 'confirm or decline this row', target: `spec:${row.id}`,
      actions: [{ verb: 'spec-approve', args: { ids: row.id } }, { verb: 'spec-decline', args: { ids: row.id } }] })),
    ...personBlocks(state.blocks ?? []),
    ...(drafts ? [{ kind: 'draft', id: 'drafts', count: drafts, ref: String(drafts),
      text: 'draft spec rows to approve or drop' + rows.filter(row => row.staleDecision).map(row => `; ${row.stage}`).join(''), what: 'review in SPEC.md', target: 'tab:spec' }] : []),
    ...(state.relayHealthAlerts ?? []),
  ];
}
