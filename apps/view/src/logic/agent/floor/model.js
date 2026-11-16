/**
 * The agent floor's numbers, projected from the Dashboard's own model and the same ordered event history [N26].
 * src/view/page-script-2.js embeds this function's source text in the page, so it may use only its arguments and
 * the language's globals. Reading the Dashboard's model, rather than the board again, keeps the two pages agreeing
 * on every agent, segment and queue.
 *
 * @param {object} model - What dashboardModel returned for this board and moment.
 * @param {object[]} history - The board's events the Dashboard read, in any order.
 * @returns {object} The floor's headline numbers, agent rows, chart bins and four queues.
 */
export function agentFloorModel(model, history) {
  const hour = 3_600_000, { now, start } = model;
  const events = history.filter(event => Date.parse(event.event_at) <= now).sort((a, b) => a.event_id - b.event_id);
  const shoutsBy = new Map(), readySince = new Map();
  let shouts = 0;
  for (const event of events) {
    const at = Date.parse(event.event_at);
    if (event.event_kind === 'shout' && at > start) {
      shouts++;
      if (!shoutsBy.has(event.event_by)) shoutsBy.set(event.event_by, []);
      shoutsBy.get(event.event_by).push(at);
    }
    if (!event.item_id) continue;
    let detail = {};
    try { detail = JSON.parse(event.event_detail || '{}'); } catch { /* malformed detail carries no lease */ }
    // An item is ready again from the move that freed it: added, sent back, released, unheld or lapsed. A claim frees
    // it again when its lease runs out, so the latest lease end stands in for a lapse the board never wrote down.
    if (['add', 'reopen', 'reject', 'lapse', 'escalate', 'unhold_item'].includes(event.event_kind)
      || event.event_kind === 'release' && !detail.review || event.event_kind === 'refreeze' && !detail.retainedClaim) readySince.set(event.item_id, at);
    if (['claim', 'renew'].includes(event.event_kind) && Date.parse(detail.leaseUntil)) readySince.set(event.item_id, Date.parse(detail.leaseUntil));
  }
  /**
   * When the agent's current hold began. The Dashboard keeps each live hold's own start apart from the timeline it
   * draws, where a minute held twice shows as building; reading the timeline would lose a review the seat still holds.
   * Without that start, the latest claim or reservation on the item stands in.
   */
  const heldSince = held => ({ since: held.since ?? model.last(held.item, held.kind === 'build' ? 'claim' : 'reserve') });
  const order = { building: 0, reviewing: 1, 'between items': 2, quiet: 3, apart: 4 };
  // A seat whose session ended, or an advisor, holding nothing is no idle builder: it sits apart and adds no idle time [C7,#6497].
  const apart = agent => !agent.current.length && (agent.presence === 'gone' || agent.lane === 'advisor');
  const agents = model.agents.map(agent => ({ ...agent, group: apart(agent) ? 'apart' : agent.group, shoutTimes: shoutsBy.get(agent.id) ?? [],
    holding: agent.current.map(held => ({ ...held, ...heldSince(held) })) }))
    .sort((a, b) => order[a.group] - order[b.group] || b.current.length - a.current.length || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const groups = [['building', 'Building'], ['reviewing', 'Reviewing'], ['between items', 'Idle'], ['quiet', 'Quiet for 20 min or more'], ['apart', 'Gone or advising']]
    .map(([key, label]) => ({ key, label, agents: agents.filter(agent => agent.group === key) }));
  /** How many agents a group holds. */
  const count = key => groups.find(group => group.key === key).agents.length;
  const landed = model.landed.filter(entry => entry.at > now - 24 * hour);
  const inReview = model.inReview.map(item => ({ item, at: model.last(item, 'submit') }));
  /** One kind of agent time, summed over every agent. */
  const sum = key => agents.filter(agent => key !== 'idle' || agent.group !== 'apart').reduce((total, agent) => total + agent[key], 0);
  return {
    now, start, complete: model.complete,
    numbers: {
      live: agents.length - count('quiet') - count('apart'), seen: agents.length,
      building: count('building'), reviewing: count('reviewing'), between: count('between items'),
      landed: model.totals.day, landedRecent: model.totals.recent, peak: model.peak,
      accepted: model.totals.passed, sentBack: model.totals.sentBack,
      inReview: inReview.length,
      unreviewed: inReview.filter(({ item }) => !item.reviewer || !(Date.parse(item.reviewUntil) > now)).length,
      waiting: model.landing.length, ready: model.next.length,
      shouts: model.complete ? shouts : null, allTime: model.totals.allTime,
    },
    bins: model.bins,
    time: { build: sum('build'), review: sum('review'), idle: sum('idle') },
    groups,
    landedMarks: landed.filter(entry => entry.at > start).map(entry => entry.at),
    queues: [
      { key: 'review', label: 'In review', rows: inReview, late: hour },
      { key: 'landing', label: 'Accepted, waiting to land', rows: model.landing.map(item => ({ item, at: model.last(item, 'accept') })), late: hour },
      { key: 'ready', label: 'Ready, nobody building', rows: model.next.map(item => ({ item, at: readySince.get(item.id) ?? (Date.parse(item.updatedAt) || now) })), late: null },
      { key: 'landed', label: 'Landed · 24 h', rows: landed.map(entry => ({ item: entry.item, at: entry.at })), late: null },
    ],
  };
}
