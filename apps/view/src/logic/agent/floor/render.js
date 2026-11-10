/**
 * Render the agent floor: the Dashboard's Agents card opened up to the whole board, with every number, every agent's
 * four hours and every queue in full [N26,N38]. src/view/page-script-2.js embeds this function's source text in the
 * page, so it may use only its arguments and the language's globals. Every width is an SVG attribute, because the
 * view's stylesheet policy refuses inline styles.
 *
 * @param {object} floor - What agentFloorModel returned.
 * @param {{ back?: string, locale?: string, timeZone?: string }} [options] - Link and explicit display preferences.
 * @returns {string} The page's markup.
 */
export function agentFloorHtml(floor, { back = '#dashboard', locale = 'en-US', timeZone = 'UTC' } = {}) {
  const f = floor, n = f.numbers, hour = 3_600_000, frame = f.now - f.start;
  /** Escape text and attribute values that come from a board. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** Minutes as the floor says them: 23m under an hour, 1.5h from an hour up. */
  const span = ms => { const minutes = Math.max(0, Math.round(ms / 60_000)); return minutes < 60 ? minutes + 'm' : (minutes / 60).toFixed(1) + 'h'; };
  /** A number the history has not finished loading reads as a dash, never as a zero. */
  const count = value => value === null || value === undefined ? '—' : Number(value).toLocaleString(locale);
  /** A clock time in the explicitly supplied display zone. */
  const clock = (at, seconds = false) => new Date(at).toLocaleTimeString(locale, seconds ? { timeZone, hour: 'numeric', minute: '2-digit', second: '2-digit' } : { timeZone, hour: 'numeric', minute: '2-digit' });
  /** The same item button the Dashboard uses, so a press opens the item through the page's own dispatcher. */
  const item = entry => '<button class="dash-item" type="button" data-go="item:' + entry.id + '"><span>#' + entry.id + '</span><b>' + esc(entry.title) + '</b></button>';
  /** Place a moment on the 1000-wide four-hour timeline. */
  const x = at => Math.max(0, Math.min(1000, (at - f.start) / frame * 1000)).toFixed(1);
  /** Pick the singular or plural wording for a count. */
  const plural = (value, one, many) => value === 1 ? one : many;

  const live = '<span class="floor-live"><i aria-hidden="true"></i>Live · <time data-floor-clock datetime="' + new Date(f.now).toISOString() + '">' + esc(clock(f.now, true)) + '</time></span>';
  const head = '<nav class="floor-crumbs" aria-label="Where you are"><a class="link" href="' + esc(back) + '" data-tab="dashboard">← Dashboard</a><span aria-hidden="true">/</span><b>Agent floor</b>' + live + '</nav>';
  const hero = '<section class="floor-hero" aria-label="Headline"><h1><em>' + count(n.landed) + ' landed in 24 hours.</em> ' + count(n.peak) + plural(n.peak, ' peak agent.', ' peak agents.') + '</h1><p>Each agent claims one item, a different agent reviews it, and what passes lands.</p></section>';

  /** One number: its key, value, one- or two-word label, tone and the hover that carries what the old sub-line said. */
  const stat = ([key, value, label, tone, source]) => '<div class="floor-number' + (tone ? ' floor-' + tone : '') + '" title="' + esc(source) + '" data-floor-stat="' + key + '" data-value="' + esc(value ?? '') + '"><b>' + count(value) + '</b><span>' + esc(label) + '</span></div>';
  const bands = [
    ['agents', 'Agents', n.seen + ' seen in 4 h', 4, [
      ['live', n.live, 'Live', '', 'Agents holding work or active in the last 20 minutes; ' + n.seen + ' agents were seen in 4 hours'],
      ['building', n.building, 'Building', 'build', 'Agents currently building an item, one item each'],
      ['reviewing', n.reviewing, 'Reviewing', 'review', 'Agents currently checking another agent\'s work'],
      ['between', n.between, 'Between', '', 'Active agents that just finished an item and are picking the next'],
    ]],
    ['recent', 'Last 4 hours', count(n.landed) + ' landed in 24 h', 4, [
      ['landed', n.landedRecent, 'Landed', 'build', 'Items landed in the last 4 hours; ' + count(n.landed) + ' in the last 24 hours'],
      ['accepted', n.accepted, 'Passed', 'review', 'Recorded review acceptances during the last 4 hours'],
      ['sent-back', n.sentBack, 'Sent back', 'back', 'Recorded rejections and reopenings during the last 4 hours'],
      ['shouts', n.shouts, 'Shouts', 'shout', 'Shouts during the last 4 hours'],
    ]],
    ['waiting', 'Waiting', '', 3, [
      ['in-review', n.inReview, 'In review', '', 'Items currently in review; ' + n.unreviewed + ' waiting for a reviewer'],
      ['waiting', n.waiting, 'To land', '', 'Accepted items waiting to land, in line'],
      ['ready', n.ready, 'Ready', '', 'Items ready for an agent to build, nothing in the way'],
    ]],
  ];
  const band = '<section class="floor-band" aria-label="Board numbers">' + bands.map(([key, heading, note, columns, stats]) =>
    '<div class="floor-grp" data-floor-group="' + key + '"><h2>' + esc(heading) + '<span>' + esc(note) + '</span></h2><div class="floor-nums floor-g' + columns + '">' + stats.map(stat).join('') + '</div></div>').join('') + '</section>';

  const peak = Math.max(0, ...f.bins.map(bin => bin.count)), tallest = Math.max(1, peak);
  const landedBars = '<svg class="floor-bars" viewBox="0 0 960 80" preserveAspectRatio="none" role="img" aria-label="Items landed per hour, last 24 hours">' + f.bins.map((bin, index) => {
    const height = bin.count ? Math.max(3, bin.count / tallest * 76) : 1;
    return '<rect' + (bin.count ? '' : ' class="floor-none"') + ' x="' + (index * 40 + 4) + '" y="' + (80 - height) + '" width="32" height="' + height + '" rx="2"><title>' + bin.count + ' landed, ' + esc(clock(bin.from)) + ' to ' + esc(clock(bin.to)) + '</title></rect>';
  }).join('') + '</svg><div class="dash-axis">' + [0, 6, 12, 18, 24].map(h => '<span>' + esc(h === 24 ? 'now' : new Date(f.now - (24 - h) * hour).toLocaleTimeString(locale, { timeZone, hour: 'numeric' })) + '</span>').join('') + '</div>';
  const landedCard = '<section class="dash-card floor-card" aria-label="Landed per hour"><h2>Landed per hour<span>' + count(n.landed) + ' in 24 h · peak ' + peak + '/h · ' + (n.landed === null ? '—' : (n.landed / 24).toFixed(1)) + '/h average</span></h2>' + landedBars + '</section>';

  const parts = [['build', 'Building', f.time.build], ['review', 'Reviewing', f.time.review], ['idle', 'Holding nothing', f.time.idle]];
  const total = parts.reduce((sum, part) => sum + part[2], 0);
  let offset = 0;
  const bar = '<svg class="floor-split" viewBox="0 0 1000 10" preserveAspectRatio="none" role="img" aria-label="Agent time: building, reviewing and holding nothing"><rect class="floor-track" width="1000" height="10"/>' + parts.map(([kind, label, value]) => {
    const width = total ? value / total * 1000 : 0, rect = '<rect class="' + kind + '" x="' + offset.toFixed(1) + '" width="' + width.toFixed(1) + '" height="10"><title>' + label + ' ' + span(value) + '</title></rect>';
    offset += width; return rect;
  }).join('') + '</svg>';
  const timeCard = '<section class="dash-card floor-card" aria-label="Agent time"><h2>Agent time<span>' + span(total) + ' of agent time · last 4 h</span></h2>' + bar + '<div class="floor-keys">' + parts.map(([kind, label, value]) => '<span><i class="' + kind + '" aria-hidden="true"></i>' + label + ' <b>' + (total ? Math.round(value / total * 100) : 0) + '%</b></span>').join('') + '</div></section>';

  const ticks = [1, 2, 3].map(h => '<rect class="floor-tick" x="' + (h * 250 - .5) + '" y="1" width="1" height="14"/>').join('');
  const landings = f.landedMarks.map(at => '<rect class="floor-landed" x="' + x(at) + '" width="1.5" height="16"/>').join('');
  /** One agent's line: its four hours, what it holds now, its build, review and idle time, and its shouts. */
  const row = agent => {
    const segments = agent.segments.map(segment => '<rect class="' + segment.kind + '" x="' + x(segment.start) + '" y="3" width="' + Math.max(2, x(segment.end) - x(segment.start)).toFixed(1) + '" height="10" rx="2"><title>#' + segment.item + ' ' + (segment.kind === 'build' ? 'building' : 'reviewing') + ' ' + span(segment.end - segment.start) + '</title></rect>').join('');
    const sent = (agent.sentBack ?? []).map(event => '<rect class="floor-back" x="' + x(event.at) + '" width="3" height="16"><title>#' + event.item + ' sent back</title></rect>').join('');
    const shouted = agent.shoutTimes.map(at => '<rect class="floor-shout" x="' + x(at) + '" y="11" width="3" height="5"><title>shout at ' + esc(clock(at)) + '</title></rect>').join('');
    const holding = agent.holding.length ? agent.holding.map(held => '<span class="floor-hold"><span class="floor-chip ' + held.kind + '">#' + held.item.id + ' ' + (held.kind === 'build' ? 'building' : 'reviewing') + ' ' + span(f.now - held.since) + '</span>' + item(held.item) + '</span>').join('') : '<span class="floor-nothing">holding nothing</span>';
    return '<div class="floor-agent floor-' + agent.group.replace(' ', '-') + '" data-floor-agent="' + esc(agent.id) + '"><b title="' + esc(agent.model ? agent.id + ' · ' + agent.model : agent.id) + '"><i aria-hidden="true"></i>' + esc(agent.name) + '</b>'
      + '<svg viewBox="0 0 1000 16" preserveAspectRatio="none" role="img" aria-label="' + esc(agent.id) + ', last four hours"><rect class="floor-track" y="5" width="1000" height="6" rx="3"/>' + ticks + landings + segments + sent + shouted + '</svg>'
      + '<span class="floor-now">' + holding + '</span>'
      + [['Build', agent.build], ['Review', agent.review], ['Idle', agent.idle]].map(([label, value]) => '<span class="floor-n" data-label="' + label + '">' + span(value) + '</span>').join('')
      + '<span class="floor-n" data-label="Shouts">' + agent.shoutTimes.length + '</span></div>';
  };
  const legend = '<div class="floor-keys">' + [['build', 'building'], ['review', 'reviewing'], ['idle', 'holding nothing'], ['shout', 'shout'], ['back', 'sent back'], ['landed', 'landed']].map(([kind, label]) => '<span><i class="' + kind + '" aria-hidden="true"></i>' + label + '</span>').join('') + '</div>';
  const axis = '<div class="floor-agent floor-axis" aria-hidden="true"><span>Agent</span><span>' + esc(clock(f.start)) + ' → now</span><span>Now</span><span>Build</span><span>Review</span><span>Idle</span><span>Shouts</span></div>';
  const rows = f.groups.filter(group => group.agents.length).map(group => '<h3 class="floor-group">' + esc(group.label) + ' · ' + group.agents.length + '</h3>' + group.agents.map(row).join('')).join('');
  const agentsCard = '<section class="dash-card floor-agents" aria-label="Agents"><div class="floor-agents-head"><h2>Agents<span>' + n.seen + ' seen in 4 h · ' + n.live + ' live</span></h2>' + legend + '</div>'
    + (rows ? axis + rows : '<p>No agent has worked here in the last 4 hours.</p>') + (f.complete ? '' : '<p class="muted">Complete history is loading; some totals show a dash until it arrives.</p>') + '</section>';

  /** One queue in full, each item with its age; an age past `late` reads in the warning colour. */
  const queue = entry => '<section class="dash-card floor-queue" aria-label="' + esc(entry.label) + '" data-floor-queue="' + entry.key + '"><h2>' + esc(entry.label) + '<b>' + entry.rows.length + '</b></h2>'
    + (entry.rows.length ? '<ul class="dash-list">' + entry.rows.map(({ item: shown, at }) => '<li>' + item(shown) + '<small' + (entry.late && f.now - at > entry.late ? ' class="dash-old"' : '') + ' data-floor-age>' + span(f.now - at) + '</small></li>').join('') + '</ul>' : '<p class="floor-nothing">None right now.</p>') + '</section>';
  const queues = '<div class="floor-queues">' + f.queues.map(queue).join('') + '</div>';
  const foot = '<p class="floor-foot" title="All-time landings come from recorded board history; this floor refreshes with board updates"><span>' + count(n.allTime) + ' items landed all time</span><span>Refreshes live with the board</span></p>';
  return '<div class="floor" aria-label="Agent floor">' + head + hero + band + '<div class="floor-two">' + landedCard + timeCard + '</div>' + agentsCard + queues + foot + '</div>';
}
