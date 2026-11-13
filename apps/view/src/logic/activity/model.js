/** Project one Activity sentence per human action and one disclosure per native sentinel scan [N26].
 * Standalone for the served/exported page: no board reads, clocks, or transports of its own.
 */
export function activityModel(project, { words } = {}) {
  const parse = event => { try { return JSON.parse(event.event_detail || '{}') || {}; } catch { return {}; } };
  const events = [...(project.events ?? [])].sort((a, b) => a.event_id - b.event_id);
  const items = new Map((project.items ?? []).map(item => [item.id, item]));
  const agents = new Map((project.agents ?? []).map(agent => [agent.agent_id, agent]));
  const shouts = new Map((project.shouts ?? []).map(shout => [shout.shout_id, shout]));
  const rows = [], consumed = new Set();
  /** Count the blocked object, retaining distinct kinds and every original cause in the disclosure. */
  const subjectKey = finding => {
    const id = finding.item ?? /^#([1-9][0-9]*)\b/u.exec(finding.subject ?? '')?.[1];
    if (Number.isSafeInteger(Number(id)) && Number(id) > 0) return `item:${Number(id)}`;
    const cause = String(finding.cause ?? '').replace(/^refusal:/u, '');
    const kind = /^RUNNER_/u.test(cause) ? 'runner' : /^(?:AGENT_|IDLE_AGENT$)/u.test(cause) ? 'seat' : 'subject';
    return `${kind}:${finding.subject ?? finding.key}`;
  };
  /** Native item context wins; otherwise use the first mentioned item that actually belongs to this board. */
  const relatedItem = (event, detail, shout, text) => {
    const target = /^item:(\d+)$/u.exec(shout?.shout_to ?? detail.to ?? '')?.[1];
    const explicit = Number(event.item_id ?? detail.item ?? target ?? shout?.shout_evidence_item);
    if (Number.isSafeInteger(explicit) && explicit > 0) return items.get(explicit) ?? { id: explicit, title: '' };
    const mentioned = [...text.matchAll(/#(\d+)/gu)].map(match => Number(match[1])).find(id => items.has(id));
    return mentioned === undefined ? null : items.get(mentioned);
  };
  const handoffKey = event => JSON.stringify([event.event_by, Math.floor(Date.parse(event.event_at) / 60_000)]);
  const releases = new Map();
  for (const event of events) {
    if (event.event_kind !== 'release' || parse(event).review) continue;
    const key = handoffKey(event);
    if (!releases.has(key)) releases.set(key, []);
    releases.get(key).push(event);
  }
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
    const failingSubjects = new Set(changed.filter(entry => !entry.resolved).map(subjectKey));
    const stuckSubjects = new Set(stuck.map(subjectKey));
    // A newly reported cause and an older cause can describe the same still-blocked item.
    for (const subject of failingSubjects) stuckSubjects.delete(subject);
    if (scan || changed.length || heldBack) rows.push({ id: `sentinels:${scan?.event_id ?? pending.at(-1)?.event_id}`, category: 'sentinels', kind: 'sentinels',
      at: scan?.event_at ?? pending.at(-1)?.event_at, findings: changed, failing: failingSubjects.size,
      resolved: changed.filter(entry => entry.resolved).length, stuck: stuckSubjects.size, heldBack, stillStuck: stuck });
    previous = active; pending = [];
  };
  const verbs = { claim: 'started building', release: 'let go of', fact: 'added a note', note: 'added a note', 'proof-run': 'ran the proof',
    reserve: 'started reviewing', accept: 'passed', reject: 'sent back', reopen: 'sent back', submit: 'submitted for review',
    add: 'added', merged: 'landed', 'main-moved': 'moved main', withdraw: 'withdrew', patch: 'updated', renew: 'continued building', lapse: 'released an expired lease for' };
  for (const event of events) {
    if (['health-failure', 'health-resolved'].includes(event.event_kind) || isNotice(event)) { pending.push(event); continue; }
    if (event.event_kind === 'health-scan') { run(event); continue; }
    if (['activity-delivered', 'flake-observation', 'usage', 'shared-usage'].includes(event.event_kind)) continue;
    const detail = parse(event), shout = shouts.get(detail.shout);
    if (['shout', 'shout_news', 'answer'].includes(event.event_kind)) {
      const text = shout?.shout_text ?? '';
      const question = shout?.shout_decision === 1 || shout?.shout_decision === true || detail.decision === true
        || detail.kind === 'question' || /\?\s*$/u.test(text);
      rows.push({ id: event.event_id, at: event.event_at, category: 'shouts', kind: 'shout', by: event.event_by, to: shout?.shout_to ?? detail.to,
        words: text, verb: question ? 'asked' : 'told', item: relatedItem(event, detail, shout, text), agent: agents.get(event.event_by) });
      continue;
    }
    if ((!event.item_id && event.event_kind !== 'main-moved') || !verbs[event.event_kind] || consumed.has(event.event_id)) continue;
    let released = null;
    if (event.event_kind === 'claim') {
      released = releases.get(handoffKey(event))?.find(other => other.item_id !== event.item_id && !consumed.has(other.event_id));
      if (released) consumed.add(released.event_id);
    }
    rows.push({ id: event.event_id, at: event.event_at, category: 'work', kind: event.event_kind, verb: words ? words({ kind: event.event_kind === 'fact' ? detail.kind || 'fact' : event.event_kind }).label : verbs[event.event_kind],
      by: event.event_by, agent: agents.get(event.event_by), item: event.item_id ? items.get(event.item_id) ?? { id: event.item_id, title: '' } : null,
      released: released ? items.get(released.item_id) ?? { id: released.item_id, title: '' } : null,
      detail: ['submit', 'accept', 'reject', 'merged', 'main-moved'].includes(event.event_kind) ? detail : null });
  }
  if (pending.length) run(null);
  // A release may precede its matching claim; remove the earlier standalone row after pairing.
  const sorted = rows.filter(row => !consumed.has(row.id)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  // A landing is one row: a main move whose items each landed within a few minutes folds into those landed rows.
  const folded = new Set();
  for (const moved of sorted.filter(row => row.kind === 'main-moved' && Array.isArray(row.detail?.items) && row.detail.items.length)) {
    const landed = moved.detail.items.map(id => sorted.find(row => row.kind === 'merged' && row.item?.id === id && !row.mainSha
      && Math.abs(Date.parse(row.at) - Date.parse(moved.at)) <= 5 * 60_000));
    if (!landed.every(Boolean)) continue;
    for (const row of landed) row.mainSha = typeof moved.detail.sha === 'string' ? moved.detail.sha : null;
    folded.add(moved.id);
  }
  const ordered = sorted.filter(row => !folded.has(row.id));
  // Consecutive "continued building" rows by one seat for one item read as one row: the latest time, and how many updates.
  const result = [];
  for (const row of ordered) {
    const last = result.at(-1);
    if (row.kind === 'renew' && last?.kind === 'renew' && last.by === row.by && last.item?.id === row.item?.id) {
      last.updates += 1; last.verb = 'continued building · ' + last.updates + ' updates';
    } else result.push(row.kind === 'renew' ? { ...row, updates: 1 } : row);
  }
  return { rows: result, counts: { all: result.length, work: result.filter(row => row.category === 'work').length,
    sentinels: result.filter(row => row.category === 'sentinels').length, shouts: result.filter(row => row.category === 'shouts').length } };
}
