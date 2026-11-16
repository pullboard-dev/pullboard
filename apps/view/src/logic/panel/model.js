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

/**
 * Group the shouts the page holds into item threads and sort them into the Shouts page's places: the asks waiting on the
 * person, today's threads, and the Earlier fold [N26]. Pure: the page passes plain shouts, item facts and the viewer's
 * read marks, and the clock; nothing here reads the browser. The page embeds this function's source, so it reads nothing
 * outside itself.
 *
 * @param {{
 *   messages: { id: number, from: string, to: string, at: string, ms: number, text: string, decision: boolean, answers: number|null, item: string|null }[],
 *   openIds?: number[], personAskIds?: number[], queueAskIds?: number[],
 *   items?: Record<string, { title: string, chip: { tone: string, label: string }|null, href?: string }>,
 *   startOfToday: number,
 *   seen?: { base: number|null, read: Record<string, number> },
 *   filter?: string, openKey?: string|null, foundId?: number|null, folded?: boolean,
 * }} input
 * @returns {{ needs: object[], threads: object[], earlier: { threads: object[], open: boolean }, counts: { you: number, questions: number, all: number },
 *   since: { base: number|null, unread: number, asks: number }, feed: { n: number, from: string|null, to: string|null }, oldestAsk: string|null,
 *   openKey: string|null, filter: string }}
 */
export function shoutsModel({ messages, openIds = [], personAskIds = [], queueAskIds = [], items = {}, startOfToday, seen = { base: null, read: {} }, filter = 'all', openKey = null, foundId = null, folded = false }) {
  const AUTOMATED = /^(sentinel|landing|merge|board|pullboard|gate|lander|system)$/u;
  const kindOf = (from) => from === 'person' ? 'you' : from === 'coordinator' ? 'coord' : AUTOMATED.test(from) ? 'auto' : 'seat';
  const markOf = (message) => message.decision ? { tone: 'ruling', label: 'Ruling' }
    : /^gate red\b/iu.test(message.text) ? { tone: 'gate', label: 'Gate red' }
      : /^main moved to\b|\bconflicts in\b/iu.test(message.text) ? { tone: 'blk', label: 'Conflict' } : null;
  const toWords = (to) => to === 'coordinator+person' ? 'coordinator and you' : String(to).startsWith('item:') ? '#' + String(to).slice(5) : to === 'person' ? 'you' : String(to);
  const byId = new Map(messages.map((message) => [message.id, message]));
  const open = new Set(openIds);
  // A reply belongs to its question's item even when the reply names none.
  const itemOf = (message) => {
    const visited = new Set();
    for (let entry = message; entry && !visited.has(entry.id); entry = byId.get(entry.answers)) {
      visited.add(entry.id);
      if (entry.item) return entry.item;
    }
    return null;
  };
  const groups = new Map();
  for (const message of byId.values()) {
    const item = itemOf(message), key = item ? 'item:' + item : 'none';
    if (!groups.has(key)) groups.set(key, { key, item, list: [] });
    groups.get(key).list.push(message);
  }
  const openedKey = openKey ?? (foundId === null ? null : [...groups.values()].find((group) => group.list.some((message) => message.id === foundId))?.key ?? null);
  const floorOf = (key) => seen.base === null || seen.base === undefined ? Infinity : Math.max(seen.base, seen.read?.[key] ?? 0);
  const threads = [...groups.values()].map(({ key, item, list }) => {
    const messagesOf = [...list].sort((a, b) => a.id - b.id);
    const last = messagesOf.at(-1), info = item ? items[item] : null;
    const askId = messagesOf.map((message) => message.id).find((id) => personAskIds.includes(id)) ?? null;
    const queued = foundId !== null && messagesOf.some((message) => message.id === foundId && queueAskIds.includes(message.id)) ? foundId : null;
    const quiet = kindOf(last.from) === 'auto';
    // What the person has not read: what others said after the viewer's mark, the thread's own read mark and the person's last word in it.
    const floor = Math.max(floorOf(key), ...messagesOf.filter((message) => kindOf(message.from) === 'you').map((message) => message.ms), -Infinity);
    const unreadCount = messagesOf.filter((message) => kindOf(message.from) !== 'you' && message.ms > floor).length;
    return { key, item, title: item ? info?.title || 'Item #' + item : quiet ? 'Notices with no item' : 'Shouts with no item',
      chip: item ? info?.chip ?? null : { tone: 'none', label: 'No item' }, href: item ? info?.href ?? '' : '', lane: item ? info?.lane ?? '' : '',
      unread: unreadCount > 0, unreadCount, quiet, open: key === openedKey,
      toYou: messagesOf.some((message) => message.to === 'person' || message.to === 'coordinator+person'),
      hasAsk: messagesOf.some((message) => open.has(message.id)),
      ask: askId !== null ? { id: askId, ordinary: false } : queued !== null ? { id: queued, ordinary: true } : null,
      last: { from: last.from, kind: kindOf(last.from), text: last.text, mark: markOf(last), at: last.at, ms: last.ms },
      count: messagesOf.length, firstAt: messagesOf[0].at, firstMs: messagesOf[0].ms,
      messages: messagesOf.map((message) => ({ id: message.id, from: message.from, model: message.model || '', to: toWords(message.to), kind: kindOf(message.from), text: message.text, mark: markOf(message),
        at: message.at, ms: message.ms, fresh: kindOf(message.from) !== 'you' && message.ms > floor, found: message.id === foundId })) };
  }).sort((a, b) => b.last.ms - a.last.ms);
  const needsKeys = new Set(threads.filter((thread) => thread.ask && !thread.ask.ordinary).map((thread) => thread.key));
  const needs = threads.filter((thread) => needsKeys.has(thread.key));
  const rest = threads.filter((thread) => !needsKeys.has(thread.key) && (filter === 'questions' ? thread.hasAsk : filter === 'you' ? thread.toYou : true));
  const today = rest.filter((thread) => thread.last.ms >= startOfToday), earlier = rest.filter((thread) => thread.last.ms < startOfToday);
  const times = messages.map((message) => message.ms).filter(Number.isFinite);
  const newest = messages.reduce((a, b) => (a && a.ms >= b.ms ? a : b), null), oldest = messages.reduce((a, b) => (a && a.ms <= b.ms ? a : b), null);
  const askTimes = needs.map((thread) => thread.messages.find((message) => personAskIds.includes(message.id))).filter(Boolean);
  const oldestAsk = askTimes.length ? askTimes.reduce((a, b) => (a.ms <= b.ms ? a : b)).at : null;
  return {
    needs, threads: today,
    earlier: { threads: earlier, open: folded || earlier.some((thread) => thread.open) },
    counts: { you: threads.filter((thread) => thread.toYou).length, questions: threads.filter((thread) => thread.hasAsk).length, all: threads.length },
    since: { base: seen.base ?? null, unread: threads.filter((thread) => thread.unread).length, asks: needs.length },
    feed: { n: times.length, from: oldest?.at ?? null, to: newest?.at ?? null }, oldestAsk, openKey: openedKey, filter,
  };
}
