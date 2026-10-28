/** Bound rendered delivery groups, never source history or unacted interrupt obligations [R2,N26,H16]. */
export function budgetInbox(document, limit, lines, diagnostics = []) {
  const { shouts, activity } = document;
  const direct = new Set(shouts.map(shout => shout.shout_id));
  const groups = activity.interrupts.map(interrupt => ({ kind: 'interrupt', count: 1, interrupt }));
  for (const shout of shouts) groups.push({ kind: 'shout', count: 1, shout,
    entries: activity.entries.filter(entry => entry.shout === shout.shout_id) });
  for (const entry of activity.entries) if (!direct.has(entry.shout)) {
    groups.push({ kind: entry.shout ? 'shout' : 'activity', count: 1, entries: [entry] });
  }
  for (const digest of activity.digests) groups.push({ kind: 'digest', count: digest.count, digest });
  const omitted = {};
  for (const group of groups) omitted[group.kind] = (omitted[group.kind] ?? 0) + group.count;
  const result = { ...document, shouts: [], activity: { ...activity, interrupts: [], entries: [], digests: [] },
    budget: { limit, counting: 'utf8-bytes', omitted, summary: '' } };
  /** Name every elided group without emitting a fragment of its source body. */
  const summarize = () => {
    const counts = Object.entries(omitted).filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kind}`).join(', ');
    result.budget.summary = counts ? `Summarized: ${counts}; read item history or log for details. Increase inbox.tokenBudget to deliver withheld interrupts.` : '';
  };
  summarize();
  for (const group of groups) {
    if (group.interrupt) result.activity.interrupts.push(group.interrupt);
    if (group.shout) result.shouts.push(group.shout);
    result.activity.entries.push(...(group.entries ?? []));
    if (group.digest) result.activity.digests.push(group.digest);
    omitted[group.kind] -= group.count;
    summarize();
    // Agents are renderer context, never part of the public document. Reserve the exact possible cursor diagnostic.
    const { agents, ...publicDocument } = result;
    const measured = { ...publicDocument, ...(diagnostics.length ? { diagnostics } : {}) };
    const bytes = Math.max(Buffer.byteLength(JSON.stringify({ version: 1, ...measured }, null, 2) + '\n'),
      Buffer.byteLength([...lines(result), ...diagnostics].join('\n') + '\n'));
    if (bytes > limit) {
      if (group.interrupt) result.activity.interrupts.pop();
      if (group.shout) result.shouts.pop();
      if (group.entries?.length) result.activity.entries.splice(-group.entries.length);
      if (group.digest) result.activity.digests.pop();
      omitted[group.kind] += group.count;
      summarize();
    }
  }
  return result;
}
