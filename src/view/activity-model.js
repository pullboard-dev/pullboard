/** Project one Activity sentence per human action and one disclosure per native sentinel scan [N26].
 * Standalone for the served/exported page: no board reads, clocks, or transports of its own.
 */
export function activityModel(project) {
  const parse = event => { try { return JSON.parse(event.event_detail || '{}') || {}; } catch { return {}; } };
  const events = [...(project.events ?? [])].sort((a, b) => a.event_id - b.event_id);
  const items = new Map((project.items ?? []).map(item => [item.id, item]));
  const agents = new Map((project.agents ?? []).map(agent => [agent.agent_id, agent]));
  const shouts = new Map((project.shouts ?? []).map(shout => [shout.shout_id, shout]));
  const rows = [], consumed = new Set();
  let previous = [], pending = [];
  const isNotice = event => {
    if (event.event_by !== 'sentinel' || !['shout', 'shout_news'].includes(event.event_kind)) return false;
    const detail = parse(event), shout = shouts.get(detail.shout);
    return /^(?:Stuck:|Resolved:|Health: \d+ more notices)/u.test(shout?.shout_text ?? '');
  };
  /** A notice's native text is a fallback when the loaded history begins partway through its scan. */
  const notice = event => {
    const shout = shouts.get(parse(event).shout), text = shout?.shout_text ?? '';
    const match = /^(Stuck|Resolved): (.*?) \[([A-Z][A-Z0-9_]+)\], since (\S+)\. (.*?)(?: Owner: (.*?)\.)? Next: ([\s\S]*)$/u.exec(text);
    if (!match) return null;
    return { cause: match[3], since: match[4], why: match[5], owner: match[6], next: match[7], subject: match[2], resolved: match[1] === 'Resolved' };
  };
  /** Close one native transaction's automatic observations, deduplicating its two addressed deliveries. */
  const run = scan => {
    const detail = scan ? parse(scan) : {}, active = Array.isArray(detail.active) ? detail.active : [];
    const known = [...active, ...previous];
    const findings = new Map();
    let heldBack = 0;
    for (const event of pending) {
      if (isNotice(event)) {
        const text = shouts.get(parse(event).shout)?.shout_text ?? '';
        const held = /^Health: (\d+) more notices/u.exec(text);
        if (held) { heldBack = Math.max(heldBack, Number(held[1])); continue; }
        const fallback = notice(event);
        if (!fallback) continue;
        const key = `${fallback.cause}:${fallback.since}:${fallback.why}:${fallback.resolved}`;
        if (!findings.has(key)) findings.set(key, { ...fallback, at: event.event_at });
        continue;
      }
      const d = parse(event), resolved = event.event_kind === 'health-resolved';
      const finding = known.find(entry => entry.key === d.key && entry.since === d.since)
        ?? { ...d, cause: String(d.cause ?? '').replace(/^refusal:/u, '') };
      if (!finding.subject && !event.item_id) continue;
      const match = [...findings.entries()].find(([, entry]) => entry.cause === String(finding.cause).replace(/^refusal:/u, '') && entry.since === finding.since && entry.resolved === resolved);
      if (match) findings.set(match[0], { ...finding, resolved, at: event.event_at });
      else findings.set(`${d.key}:${d.since}:${resolved}`, { ...finding, resolved, at: event.event_at });
    }
    // A scan may record no new notices while existing findings are still stuck.
    const changed = [...findings.values()], stuck = active.filter(entry => !changed.some(change => !change.resolved && change.key === entry.key));
    if (scan || changed.length || heldBack) rows.push({ id: `sentinels:${scan?.event_id ?? pending.at(-1)?.event_id}`, category: 'sentinels', kind: 'sentinels',
      at: scan?.event_at ?? pending.at(-1)?.event_at, findings: changed, failing: changed.filter(entry => !entry.resolved).length,
      resolved: changed.filter(entry => entry.resolved).length, stuck: stuck.length, heldBack, stillStuck: stuck });
    previous = active; pending = [];
  };
  const verbs = { claim: 'started building', release: 'let go of', fact: 'added a note', note: 'added a note', 'proof-run': 'ran the proof',
    reserve: 'started reviewing', accept: 'passed', reject: 'sent back', reopen: 'sent back', submit: 'submitted for review',
    add: 'added', merged: 'landed', withdraw: 'withdrew', patch: 'updated', renew: 'continued building', lapse: 'released an expired lease for' };
  for (const event of events) {
    if (['health-failure', 'health-resolved'].includes(event.event_kind) || isNotice(event)) { pending.push(event); continue; }
    if (event.event_kind === 'health-scan') { run(event); continue; }
    if (['activity-delivered', 'flake-observation'].includes(event.event_kind)) continue;
    const detail = parse(event), shout = shouts.get(detail.shout);
    if (['shout', 'shout_news', 'answer'].includes(event.event_kind)) {
      rows.push({ id: event.event_id, at: event.event_at, category: 'shouts', kind: 'shout', by: event.event_by, to: shout?.shout_to ?? detail.to,
        words: shout?.shout_text ?? '', verb: 'told', agent: agents.get(event.event_by) });
      continue;
    }
    if (!event.item_id || !verbs[event.event_kind] || consumed.has(event.event_id)) continue;
    let released = null;
    if (event.event_kind === 'claim') {
      released = events.find(other => other.event_kind === 'release' && other.event_by === event.event_by && other.item_id !== event.item_id
        && !consumed.has(other.event_id) && Math.floor(Date.parse(other.event_at) / 60_000) === Math.floor(Date.parse(event.event_at) / 60_000) && !parse(other).review);
      if (released) consumed.add(released.event_id);
    }
    rows.push({ id: event.event_id, at: event.event_at, category: 'work', kind: event.event_kind, verb: verbs[event.event_kind],
      by: event.event_by, agent: agents.get(event.event_by), item: items.get(event.item_id) ?? { id: event.item_id, title: '' },
      released: released ? items.get(released.item_id) ?? { id: released.item_id, title: '' } : null });
  }
  if (pending.length) run(null);
  // A release may precede its matching claim; remove the earlier standalone row after pairing.
  const result = rows.filter(row => !consumed.has(row.id)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { rows: result, counts: { all: result.length, work: result.filter(row => row.category === 'work').length,
    sentinels: result.filter(row => row.category === 'sentinels').length, shouts: result.filter(row => row.category === 'shouts').length } };
}
