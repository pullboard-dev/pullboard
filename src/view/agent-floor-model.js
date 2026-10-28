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
    // An item is ready again from the move that freed it: added, sent back, released or let lapse.
    if (['add', 'reopen', 'reject', 'release', 'lapse'].includes(event.event_kind) && event.item_id) readySince.set(event.item_id, at);
  }
  /**
   * When the agent's current hold began: the run of its timeline that reaches now on this item. A run that starts
   * at the window's edge began earlier, so `before` says the age is at least the window.
   */
  const heldSince = (agent, held) => {
    let since = now;
    for (const segment of [...agent.segments].reverse()) {
      if (segment.item !== held.item.id || segment.kind !== held.kind || segment.end < since) break;
      since = segment.start;
    }
    return { since, before: since <= start };
  };
  const order = { building: 0, reviewing: 1, 'between items': 2, quiet: 3 };
  const agents = model.agents.map(agent => ({ ...agent, shoutTimes: shoutsBy.get(agent.id) ?? [],
    holding: agent.current.map(held => ({ ...held, ...heldSince(agent, held) })) }))
    .sort((a, b) => order[a.group] - order[b.group] || b.current.length - a.current.length || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const groups = [['building', 'Building'], ['reviewing', 'Reviewing'], ['between items', 'Between items'], ['quiet', 'Quiet for 20 min or more']]
    .map(([key, label]) => ({ key, label, agents: agents.filter(agent => agent.group === key) }));
  /** How many agents a group holds. */
  const count = key => groups.find(group => group.key === key).agents.length;
  const landed = model.landed.filter(entry => entry.at > now - 24 * hour);
  const inReview = model.inReview.map(item => ({ item, at: model.last(item, 'submit') }));
  /** One kind of agent time, summed over every agent. */
  const sum = key => agents.reduce((total, agent) => total + agent[key], 0);
  return {
    now, start, complete: model.complete,
    numbers: {
      live: agents.length - count('quiet'), seen: agents.length,
      building: count('building'), reviewing: count('reviewing'), between: count('between items'),
      landed: model.totals.day, landedRecent: model.totals.recent,
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
