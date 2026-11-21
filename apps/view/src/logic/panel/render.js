/**
 * The agents rail: one line per agent holding work, grouped by where its held item stands with sent back first, and the idle
 * idle agents folded into one line. Pure, like shoutsHtml; the caller prepares each agent's escaped name, model and age.
 *
 * @param {{ listed: any[], busy: any[], idle: any[], idleOpen: boolean, activeAgent: string|null, allAgents: boolean, totalAgents: number, showAll: boolean, emptyText: string }} panel
 * @param {{ now: number, dashboardHref: string }} context
 * @returns {string}
 */
export function agentsPanelHtml(panel, { now, dashboardHref }) {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const groupOf = (agent) => {
    const back = agent.holding.find((item) => item.state === 'back');
    if (back) return { key: 'back', item: back };
    const first = agent.holding[0];
    return { key: first.status === 'submitted' || first.state === 'verify' ? 'review' : 'build', item: first };
  };
  const named = { back: 'Sent back', build: 'Building', review: 'In review' };
  const groups = ['back', 'build', 'review'].map((key) => ({ key, rows: panel.busy.map((agent) => ({ agent, ...groupOf(agent) })).filter((entry) => entry.key === key) })).filter((group) => group.rows.length);
  const line = ({ agent, key, item }) => {
    const more = agent.holding.length - 1, since = Date.parse(item.since || agent.lastMoveAt || ''), hours = Number.isFinite(since) ? (now - since) / 36e5 : 0;
    const title = agent.agentId + ' holds #' + item.id + (more ? ' and ' + more + ' more' : '') + (agent.modelHtml ? ' · ' + agent.modelHtml : '');
    return '<button class="sx-ag ' + key + (panel.activeAgent === agent.agentId ? ' on' : '') + '" type="button" data-agent="' + esc(agent.agentId) + '" title="' + esc(title) + '">'
      + (key === 'back' ? '<i class="sx-bk"></i>' : '<i class="sx-dot ' + key + '"></i>') + '<span class="sx-it"><code>#' + item.id + '</code>' + item.titleTextHtml + '</span>'
      + '<span class="sx-more">' + (more ? '+' + more : '') + '</span><code class="sx-seat">' + agent.nameHtml + '</code>' + (item.ageHtml || agent.ageHtml || '<time></time>').replace(/^<time/u, '<time class="' + (hours >= 2 ? 'late' : '') + '"') + '</button>';
  };
  const shown = groups.map((group) => '<div class="sx-grp ' + group.key + '">' + named[group.key] + '<span>' + group.rows.length + '</span></div>' + group.rows.map(line).join('')).join('');
  const pill = (agent) => '<button class="sx-idle-n' + (panel.activeAgent === agent.agentId ? ' on' : '') + '" type="button" data-agent="' + esc(agent.agentId) + '" title="' + esc(agent.name || agent.agentId) + (agent.modelHtml ? ' · ' + agent.modelHtml : '') + '">' + agent.nameHtml + '</button>';
  const all = panel.showAll ? '<button class="sx-all" type="button" data-all-agents>' + (panel.allAgents ? 'show only agents at work' : 'show all ' + panel.totalAgents) + '</button>' : '';
  const idle = panel.idle.length ? '<button class="sx-idlehead" type="button" data-fold="idle" aria-expanded="' + Boolean(panel.idleOpen) + '"><i class="sx-dot idle"></i><span><b>' + panel.idle.length + '</b> idle</span><span class="chv">›</span></button>'
    + (panel.idleOpen ? '<div class="sx-idlelist">' + panel.idle.map(pill).join('') + all + '</div>' : '') : all ? '<div class="sx-idlelist">' + all + '</div>' : '';
  return '<section class="sx-sec sx-first"><div class="shd"><p class="hd1">Agents<span class="sx-count">' + panel.totalAgents + '</span></p><span class="cap2">' + panel.busy.length + ' holding work</span>'
    + '<a class="sx-lk" href="' + esc(dashboardHref) + '" data-go="tab:dashboard">Dashboard ›</a></div>'
    + '<div class="sx-card sx-agents">' + (panel.listed.length ? shown + idle : '<p class="sx-empty">' + esc(panel.emptyText) + '</p>') + '</div></section>';
}

/**
 * The Flow panel as HTML [N26,C7]: one one-line row per unlanded item with its id and cause, in input order, then the idle
 * seats on one line, or a single quiet empty line when there is nothing to show. Pure: it writes only what the model gives it.
 *
 * @param {{ rows: { id: number, cause: string }[], idle: { seat: string, reason: string }[] }} model - What flowPanelModel returns (apps/view/src/logic/panel/flow.js).
 * @returns {string}
 */
export function flowPanelHtml(model) {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const rows = model.rows.map((row) => '<div class="sx-fl"><code>#' + esc(row.id) + '</code><span class="sx-it">' + esc(row.cause) + '</span></div>').join('');
  const idle = model.idle.length ? '<div class="sx-fl sx-flidle"><span class="sx-it">Idle: '
    + model.idle.map((entry) => '<code>' + esc(entry.seat) + '</code> ' + esc(entry.reason)).join(' · ') + '</span></div>' : '';
  const body = rows || idle ? rows + idle : '<p class="sx-empty">Nothing is waiting to land.</p>';
  return '<section class="sx-sec"><div class="shd"><p class="hd1">Flow<span class="sx-count">' + model.rows.length + '</span></p></div><div class="sx-card sx-flow">' + body + '</div></section>';
}

/**
 * The Shouts page as HTML [N26]: the since-you-left line, the asks waiting on the person, the threads as one-line rows that
 * open in place, and the Earlier fold. Pure: it writes only what the model and the caller's clock formatters give it. The page
 * embeds this function's source, so it reads nothing outside itself, its own escaping and markup helpers included.
 *
 * @param {ReturnType<import('./model.js').shoutsModel>} model
 * @param {{ clock: (iso: string) => string, ago: (iso: string) => string, day: (iso: string) => string, startOfToday: number,
 *   readOnly?: boolean, rich?: Record<string, string>, full?: number[], allMessages?: string[], addressNote?: string, bar?: string }} view
 * @returns {string}
 */
export function shoutsHtml(model, { clock, ago, day, startOfToday, readOnly = false, rich = {}, full = [], allMessages = [], addressNote = '', bar = '' }) {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const sender = (from, kind, to, model) => '<span class="sx-snd ' + kind + '"' + (to ? ' title="' + esc((from === 'person' ? 'you' : from) + (model ? ' (' + model + ')' : '') + ' to ' + to) + '"' : '') + '><i class="sx-si ' + kind + '"></i><span class="sx-sn">' + esc(from === 'person' ? 'you' : from) + '</span></span>';
  const mark = (value) => value ? '<span class="sx-mk ' + value.tone + '">' + esc(value.label) + '</span>' : '';
  const chip = (value) => value ? '<span class="sx-chip ' + value.tone + '">' + esc(value.label) + '</span>' : '';
  const stamp = (iso, ms) => ms >= startOfToday ? '<time data-ago="' + esc(iso) + '">' + esc(ago(iso)) + '</time>' : '<time>' + esc(day(iso)) + '</time>';
  const rangeOf = (from, to) => from && to ? ' · ' + esc(clock(from)) + (clock(from) === clock(to) ? '' : ' – ' + esc(clock(to))) : '';
  const row = (thread, asking) => {
    const last = thread.last, count = plural(thread.count, 'message') + (thread.unread ? ', ' + thread.unreadCount + ' unread' : '');
    return '<button class="sx-th' + (thread.unread ? ' unread' : '') + (thread.quiet ? ' quiet' : '') + (thread.open ? ' open' : '') + '" type="button" data-shout-thread="' + esc(thread.key) + '"' + (asking && thread.ask && !readOnly ? ' data-go="decide:' + thread.ask.id + '"' : '') + ' aria-expanded="' + thread.open + '">'
      + '<span class="sx-ud"' + (thread.unread ? ' role="img" aria-label="unread"' : '') + '></span>'
      + '<span class="sx-st">' + chip(thread.chip) + '</span>'
      + '<span class="sx-l1">' + (thread.item ? '<b class="sx-id">#' + esc(thread.item) + '</b>' : '') + '<b class="sx-tt">' + esc(thread.title) + '</b></span>'
      + '<span class="sx-r1">' + (asking && !readOnly ? '<span class="sx-act">Answer</span>' : '') + stamp(last.at, last.ms) + '</span>'
      + '<span class="sx-km">' + mark(last.mark) + '</span>'
      + '<span class="sx-l2">' + sender(last.from, last.kind) + '<span class="sx-tx">' + esc(last.text) + '</span></span>'
      + '<span class="sx-r2"><span class="sx-n" title="' + esc(count) + '">' + thread.count + '</span></span></button>';
  };
  const panel = (thread) => {
    const first = thread.firstAt, last = thread.last.at;
    const reply = readOnly ? '' : '<form class="sx-reply" data-reply="' + esc(thread.key) + '"' + (thread.ask ? ' data-ask="' + thread.ask.id + '"' + (thread.ask.ordinary ? ' data-ordinary' : '') : '') + '>'
      + '<i class="sx-si you"></i><input type="text" autocomplete="off" aria-label="' + (thread.ask ? 'Answer' : 'Reply') + '" placeholder="' + (thread.ask ? 'Answer' : 'Reply') + (thread.item ? ' on #' + esc(thread.item) : '') + '">'
      + '<span class="sx-reach">' + (thread.ask ? 'answers the ruling' : thread.item && thread.lane ? 'reaches the ' + esc(thread.lane) + ' lane' : 'reaches the coordinator') + '</span>'
      + '<button class="sx-send" type="submit">' + (thread.ask ? 'Answer' : 'Reply') + '</button></form>';
    return '<div class="sx-tp" data-thread-panel="' + esc(thread.key) + '"><div class="sx-ph conversation-heading"><span><b>' + thread.count + '</b> ' + (thread.count === 1 ? 'message' : 'messages') + ' · ' + esc(clock(first)) + (thread.count > 1 ? ' – ' + esc(clock(last)) : '') + '</span>'
      + (thread.item && thread.href ? '<a class="sx-lk" href="' + esc(thread.href) + '" data-go="item:' + esc(thread.item) + '">Item #' + esc(thread.item) + ' ›</a>' : '')
      + '<button class="sx-xb" type="button" data-shout-thread="" title="Close (Esc)" aria-label="Close thread">×</button></div>'
      + (thread.count > 20 ? '<button class="sx-earlier-msgs" type="button" data-fold="msgs:' + esc(thread.key) + '" aria-expanded="' + (allMessages.includes(thread.key) || thread.messages.some((message) => message.found)) + '">' + (allMessages.includes(thread.key) ? 'Show only the latest 12' : thread.count - 12 + ' earlier messages') + '</button>' : '')
      + '<div class="sx-msgs">' + (thread.count > 20 && !allMessages.includes(thread.key) && !thread.messages.some((message) => message.found) ? thread.messages.slice(-12) : thread.messages).map((message) => '<div class="sx-msg' + (message.kind === 'auto' ? ' quiet' : '') + (message.fresh ? ' new' : '') + (message.found ? ' found' : '') + (full.includes(message.id) ? ' full' : '') + '" id="shout-' + message.id + '" data-shout-id="' + message.id + '">'
        + (message.found ? '<h2 class="visually-hidden">Shout #' + message.id + '</h2>' : '')
        + sender(message.from, message.kind, message.to, message.model) + '<span class="sx-tx">' + mark(message.mark) + (rich[message.id] ?? esc(message.text)) + '</span><time title="' + esc(day(message.at) + ' ' + clock(message.at)) + '">' + esc(clock(message.at)) + '</time></div>').join('') + '</div>' + reply + '</div>';
  };
  const unit = (thread, asking) => row(thread, asking) + (thread.open ? panel(thread) : '');
  const since = model.since.unread || model.since.asks
    ? '<p class="sx-since">' + (model.since.base ? 'Since you left <time class="long" data-ago="' + esc(new Date(model.since.base).toISOString()) + '">' + esc(ago(new Date(model.since.base).toISOString())) + '</time>: ' : '')
      + (model.since.unread ? '<b>' + model.since.unread + '</b> ' + (model.since.unread === 1 ? 'thread' : 'threads') + ' with new shouts' + (model.since.asks ? ' · ' : '') : '')
      + (model.since.asks ? '<span class="amb">' + plural(model.since.asks, 'ask') + '</span> ' + (model.since.asks === 1 ? 'waits' : 'wait') + ' for your answer' : '')
      + (model.since.unread ? '<button class="sx-end" type="button" data-mark-read>Mark all read</button>' : '') + '</p>' : '';
  const needs = model.needs.length ? '<section class="sx-sec sx-first" id="shouts-needs"><div class="shd"><p class="hd1 amb">Needs your answer<span class="sx-count amb">' + model.needs.length + '</span></p>'
    + (model.oldestAsk ? '<span class="cap2">oldest ' + esc(day(model.oldestAsk)) + '</span>' : '') + '</div><div class="sx-card sx-list">' + model.needs.map((thread) => unit(thread, true)).join('') + '</div></section>' : '';
  const earlier = model.earlier.threads;
  const fold = earlier.length ? '<button class="sx-dayrule" type="button" data-fold="earlier" aria-expanded="' + model.earlier.open + '" aria-controls="shouts-earlier"><span>Earlier</span><span class="f">' + plural(earlier.length, 'thread')
    + ' · ' + esc(day(earlier.at(-1).last.at)) + (earlier.length > 1 ? ' – ' + esc(day(earlier[0].last.at)) : '') + '</span><span class="chv">›</span></button>'
    + (model.earlier.open ? '<div id="shouts-earlier">' + earlier.map((thread) => unit(thread, false)).join('') + '</div>' : '') : '';
  const empty = !model.needs.length && !model.threads.length && !earlier.length
    ? '<p class="sx-empty">' + (model.filter === 'questions' ? 'No open questions.' : model.filter === 'you' ? 'No shouts to you.' : 'No shouts yet.') + '</p>' : '';
  const threads = '<section class="sx-sec' + (needs ? '' : ' sx-first') + '"><div class="shd"><p class="hd1">Threads<span class="sx-count">' + model.threads.length + '</span></p>'
    + (model.feed.n ? '<span class="cap2">newest ' + model.feed.n + ' shouts' + rangeOf(model.feed.from, model.feed.to) + '</span>' : '') + '</div>'
    + '<div class="sx-card sx-list" id="shouts-threads">' + model.threads.map((thread) => unit(thread, false)).join('') + fold + empty + '</div></section>';
  const filters = '<div class="sx-mfilters">' + [['you', 'For you', model.counts.you], ['questions', 'Questions', model.counts.questions], ['all', 'All', model.counts.all]].map(([value, name, count]) => '<button type="button" data-shout-filter="' + value + '"'
    + (model.filter === value ? ' class="on"' : '') + '>' + name + '<em' + (value === 'questions' ? ' class="amb"' : '') + '>' + count + '</em></button>').join('') + '</div>';
  return addressNote + bar + filters + since + needs + threads;
}
