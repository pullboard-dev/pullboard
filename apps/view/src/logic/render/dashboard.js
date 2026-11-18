/**
 * Render the approved /live-style Dashboard (dashboard-approved-1113, #6847); every number comes from its snapshot model.
 * Order: How work moved (Build, Gate, Review, Land with rates), the Now line, Release, the landed-per-hour and
 * agent-time strip, the Agents table, the four lists, Your lanes and Runners. Every count opens its filtered Items page
 * through data-dashboard-list (and data-dashboard-lane); every item row opens its item through data-go [N26].
 * The view's policy disallows inline styles, so each proportional bar is SVG geometry.
 * @param {object} model - The Dashboard snapshot model.
 * @param {object} options - Presentation settings. `gate`, `{ open, trace }`, makes each In the gate row open its gate trace panel (data-gate-trace) in place of the item: `open` is the item whose panel shows, `trace` the gate trace projection [C7].
 * @returns {string} Dashboard markup.
 */
export function dashboardHtml(model, { deferQuiet, locale = 'en-US', timeZone = 'UTC', gate = null } = {}) {
  const m = model;
  /** Escape both text and attribute values supplied by a board. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  /** The mockup's symbols stay inline so the page needs no sprite request. */
  const icon = name => {
    const paths = {
      build: '<path d="M9.5 2.5l4 4-1.5 1.5-4-4zM8 4L2.5 9.5l4 4L12 8"/>',
      review: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
      back: '<path d="M6 4L2.5 7.5 6 11"/><path d="M2.5 7.5H10a3.5 3.5 0 0 1 0 7H8"/>',
      clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
      flag: '<path d="M3.5 14V2.5M3.5 3h8l-1.5 3 1.5 3h-8"/>',
      bolt: '<path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/>',
    };
    return '<svg class="dash-icon" data-dashboard-icon="'+name+'" aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+paths[name]+'</svg>';
  };
  const num = value => Number.isFinite(value) ? value.toLocaleString(locale) : '—';
  /** Minutes under 90, else hours with one decimal: the mockup's one duration format. */
  const span = ms => { if (!Number.isFinite(ms)) return '—'; const min = Math.max(0, ms/60_000); return min >= 90 ? (min/60).toFixed(1)+'h' : Math.floor(min)+'m'; };
  const ago = at => span(m.now - at);
  /** A count that opens Items narrowed to exactly what it counts. */
  const open = (html, list, { lane = null, cls = '', title = '' } = {}) => '<button type="button" class="dash-n '+cls+'" data-dashboard-list="'+list+'"'+(lane ? ' data-dashboard-lane="'+esc(lane)+'"' : '')+(title ? ' title="'+esc(title)+'"' : '')+'>'+html+'</button>';
  const pill = (value, list, extra = {}) => open(num(value), list, { ...extra, cls: 'dash-pill' });
  /** One row that opens its item: #id, the title to an ellipsis, a faint right-hand fact. */
  const row = (cls, entry, right, late = false) => '<button type="button" class="'+cls+'" data-go="item:'+entry.id+'"><span class="dash-id">#'+entry.id+'</span><span class="dash-t" title="'+esc(entry.title)+'">'+esc(entry.title)+'</span><span class="dash-age'+(late ? ' late' : '')+'">'+right+'</span></button>';
  const label = (text, count = '') => '<h2 class="dash-lbl">'+text+count+'</h2>';
  /** Design sheet v1.1: a section's header sits on the ground above its card, label and window left, caption and link right. */
  const section = (aria, cls, head, body, { id = '', cap = '', link = '' } = {}) => '<section class="dash-sec '+cls+'"'+(id ? ' id="'+id+'"' : '')+' aria-label="'+esc(aria)+'"><div class="dash-shd">'+head+(cap ? '<span class="dash-cap2">'+cap+'</span>' : '')+(link ? link : '')+'</div>'+body+'</section>';
  /** A card's own sub-head: sans 12.5, never small capitals. */
  const sub = (text, count = '') => '<h3 class="dash-ct">'+text+count+'</h3>';
  const f = m.flow;
  /** Whether a reviewer holds this submitted item now. */
  const reserved = entry => Boolean(entry.reviewer) && Date.parse(entry.reviewUntil) > m.now;

  // 1. How work moved: Build › Gate › Review › Land over the last four hours, each with its rate.
  const rate = n => Number.isFinite(n) ? Math.round(n/4)+'/h' : '—';
  const stage = (key, dot, name, list, perHour, a, b, green = false) => '<button type="button" class="dash-stage" data-dashboard-step="'+key+'" data-dashboard-list="'+list+'"><span class="dash-stage-t"><i class="dash-dot '+dot+'"></i>'+name+'<span class="dash-rate'+(green ? ' g' : '')+'">'+perHour+'</span></span><span class="dash-stage-a">'+a+'</span><span class="dash-stage-b">'+b+'</span></button>';
  const flowCards = f ? [
    stage('build', 'building', 'Build', 'building', rate(f.submitted), '<b>'+num(f.claimed)+'</b> claimed → <b>'+num(f.submitted)+'</b> submitted', num(f.handedBack)+' handed back'+(f.buildMedian === null ? '' : ' · median '+span(f.buildMedian))),
    stage('gate', 'gate', 'Gate', 'gate', rate(f.green + f.red), '<b>'+num(f.green)+'</b> green · <b>'+num(f.red)+'</b> red', num(f.gateRunning)+' in the gate now'),
    stage('review', 'review', 'Review', 'review', rate(f.accepted + f.sentBack), '<b>'+num(f.accepted)+'</b> accepted · <b>'+num(f.sentBack)+'</b> sent back', num(f.waitingReview)+' pending review'+(f.oldestWait === null ? '' : ' · oldest '+ago(f.oldestWait))),
    stage('land', 'merged', 'Land', 'landed', rate(f.landed), '<b>'+num(f.landed)+'</b> landed · <b>'+num(m.lists.accepted.length)+'</b> to land', f.lastLanded ? 'last '+ago(f.lastLanded)+' ago' : 'none yet', true),
  ].join('') : '<p class="dash-empty">Reading the board’s history…</p>';
  const flowHtml = section('How work moved', 'dash-flowsec', label('Flow · 4 h'), '<div class="dash-card dash-flowcard"><div class="dash-flow">'+flowCards+'</div>'
    + (f ? '<p class="dash-loop" data-dashboard-loop>'+icon('back')+open(num(f.sentBack)+' sent back', 'sent-back', { cls: 'back' })+' to their builders in the last 4 hours · a different agent reviews every item</p>' : '')+'</div>');

  // 2. The Now line: where every item is, one dot, number and word per stage.
  const s = m.stages;
  const tile = (dot, value, word, list, title) => open('<i class="dash-dot '+dot+'"></i><b>'+num(value)+'</b>'+word, list, { cls: 'dash-tile', title });
  const now = section('Now', 'dash-nowsec', label('Now'), '<div class="dash-card dash-now">'+[
    tile('ready', s.ready, 'ready', 'next', 'Open, nothing blocks it'), tile('waiting', s.waiting, 'blocked', 'gated', 'Blocked by another item'),
    tile('building', s.building, 'building', 'building', 'One item each'),
    ...(s.stalled ? [tile('held', s.stalled, 'stalled', 'building', 'Claimed, but idle for 20 minutes or more')] : []),
    ...(s.waitingClaims ? [tile('waiting', s.waitingClaims, 'waiting', 'building', 'Claimed, waiting on another item')] : []), tile('gate', s.gate, 'in the gate', 'gate', 'Submitted, the gate is checking'),
    tile('review', s.review, 'in review', 'review', 'Passed the gate, in review or pending review'), tile('landing', s.toLand, 'to land', 'passed', 'Accepted, landing next'),
    tile('back', s.sentBack, 'sent back', 'sent-back', 'With their builders'), tile('held', s.held, 'held', 'held', 'Paused on purpose'),
  ].join('<span class="dash-x" aria-hidden="true"></span>')+open(num(s.active)+' open · Items ›', 'active', { cls: 'dash-tright' })+'</div>');

  // 3. Release: the release card, its stage bar and legend, In flight, then three pace tiles.
  const shipping = (() => {
    const release = m.milestone, summary = release?.summary;
    const counted = key => Number.isInteger(summary?.[key]) && summary[key] >= 0;
    const roadmap = '<button type="button" class="dash-lk" data-tab="roadmap">Roadmap ›</button>';
    if (!release || !counted('total') || !counted('left')) return section('Release', 'dash-shipsec', label('Release'), '<div class="dash-card dash-ship"><p class="dash-empty">No release is in progress.</p></div>', { link: roadmap });
    const named = /^(\d+(?:\.\d+)+)\s*:\s*(.+)$/u.exec(String(release.name ?? ''));
    const title = named ? '<span class="dash-ver">'+esc(named[1])+'</span>'+esc(named[2]) : esc(release.name);
    const parts = [['landed','landed','landed'],['landing','landing','passed'],['review','in review','review'],['building','building','building'],['ready','ready','next'],['waiting','blocked','gated'],['held','held','held']].filter(([key]) => counted(key));
    let offset = 0;
    const gap = Math.max(0.002 * summary.total, 0);
    const bar = '<svg class="dash-sbar" viewBox="0 0 '+(summary.total || 1)+' 1" preserveAspectRatio="none" role="img" aria-label="'+esc(release.name+': '+parts.map(([key,word]) => summary[key]+' '+word).join(', '))+'">'+parts.filter(([key]) => summary[key]).map(([key,word]) => { const x = offset; offset += summary[key]; return '<rect class="dash-seg-'+key+'" data-release-segment="'+key+'" data-count="'+summary[key]+'" x="'+x+'" width="'+Math.max(0, summary[key]-gap)+'" height="1"><title>'+summary[key]+' '+word+'</title></rect>'; }).join('')+'</svg>';
    const keys = '<div class="dash-keys">'+parts.map(([key,word,list]) => open('<i class="dash-sw dash-seg-'+key+'"></i><b>'+num(summary[key])+'</b> '+word, list, { cls: 'dash-key' })).join('')+'</div>';
    const pace = summary.pace ?? m.pace, measured = Number.isInteger(pace?.last6h) && Number.isInteger(pace?.last2h);
    const hour = at => new Date(at).toLocaleTimeString(locale, { timeZone, hour: 'numeric', minute: '2-digit' });
    const day = at => new Date(at).toLocaleDateString(locale, { timeZone, weekday: 'long' });
    const estimate = summary.estimate, ranged = estimate && Number.isFinite(estimate.low) && Number.isFinite(estimate.high);
    const lo = ranged ? Math.round(estimate.low) : null, hi = ranged ? Math.round(estimate.high) : null;
    const when = !ranged ? (summary.reason === 'few-landings' ? 'too few landings yet to estimate' : 'completion time unavailable')
      : day(m.now+lo*3_600_000)+', around '+hour(m.now+lo*3_600_000)+(lo === hi ? '' : ' to '+(day(m.now+hi*3_600_000) === day(m.now+lo*3_600_000) ? '' : day(m.now+hi*3_600_000)+' ')+hour(m.now+hi*3_600_000));
    const stat = (key, symbol, name, value, unit, note) => '<div class="dash-stat '+key+'" data-dashboard-tile="'+key+'"><span class="dash-stat-k">'+icon(symbol)+name+'</span><span class="dash-stat-v"><b>'+value+'</b>'+(unit ? '<span>'+unit+'</span>' : '')+'</span><small>'+esc(note)+'</small></div>';
    const flight = (cls, symbol, name, entries, kind) => {
      const holder = entry => kind === 'claim' ? esc(entry.owner)+' · '+ago(m.last(entry,'claim')) : entry.reviewer && reserved(entry) ? esc(entry.reviewer)+' · '+ago(m.last(entry,'reserve')) : 'pending review';
      const rows = entries.map((entry, index) => (index === 4 ? '<details data-dashboard-disclosure="'+kind+'"><summary>Show '+(entries.length-4)+' more</summary>' : '')+row('dash-row', entry, holder(entry))).join('')+(entries.length > 4 ? '</details>' : '');
      return '<div class="dash-ifcol '+cls+'"><h3 class="dash-ifh">'+icon(symbol)+name+open(num(entries.length), kind === 'claim' ? 'building' : 'review', { cls: 'dash-faint' })+'</h3>'+rows+'</div>';
    };
    const inflight = m.inFlight.building.length + m.inFlight.review.length;
    return section('Release', 'dash-shipsec', label('Release'), '<div class="dash-card dash-ship"><div class="dash-ship-head"><div><p class="dash-ship-name">'+title+'</p></div>'
      + '<p class="dash-togo"><b>'+open(num(summary.left)+' to go', 'next')+'</b><span>'+num(counted('landed') ? summary.landed : 0)+' of '+num(summary.total)+' landed</span></p></div>'
      + bar + keys
      + '<div class="dash-inflight"><div class="dash-cap">'+sub('In flight', pill(inflight, 'active'))+'<span class="dash-r">'+esc(named ? named[1] : release.name)+' items being built or checked now</span></div>'
      + '<div class="dash-ifcols">'+flight('building', 'build', 'Building', m.inFlight.building, 'claim')+flight('review', 'review', 'In review', m.inFlight.review, 'submit')+'</div></div>'
      + '<div class="dash-pace">'+stat('today', 'bolt', 'Today’s pace', measured ? (pace.last6h/6).toFixed(1) : '0.0', 'items an hour', (measured ? pace.last6h : 0)+' landed in the last 6 hours')
      + stat('now', 'clock', 'Right now', measured ? (pace.last2h/2).toFixed(1) : '0.0', 'items an hour', (measured ? pace.last2h : 0)+' landed in the last 2 hours')
      + stat('eta', 'flag', 'ETA', ranged ? (lo === hi ? lo : lo+'–'+hi)+' h' : 'Not yet', '', when)+'</div></div>', { link: roadmap });
  })();

  // 4. The strip: landed per hour over 24 h and how agent time split over the last four hours.
  const maxBin = Math.max(1, ...m.bins.map(bin => bin.count));
  const spark = '<svg class="dash-spark" viewBox="0 0 '+(m.bins.length*10)+' 18" preserveAspectRatio="none" role="img" aria-label="Items landed per hour, last 24 hours">'+m.bins.map((bin, index) => { const h = Math.max(0.5, bin.count/maxBin*18); return '<rect class="'+(index === m.bins.length-1 ? 'now' : '')+'" x="'+(index*10+1)+'" y="'+(18-h)+'" width="8" height="'+h+'"><title>'+esc(new Date(bin.from).toLocaleTimeString(locale, { timeZone, hour: 'numeric', minute: '2-digit' }))+': '+bin.count+' landed</title></rect>'; }).join('')+'</svg>';
  const active = m.agents.filter(agent => agent.last > m.start || agent.current.length);
  const times = ['build','review','idle'].map(key => active.reduce((sum, agent) => sum + agent[key], 0)), whole = times.reduce((a, b) => a + b, 0);
  const share = index => whole ? Math.round(times[index]/whole*100) : 0;
  // Shares of 100, so the SVG never carries raw milliseconds as geometry.
  let x0 = 0;
  const split = '<svg class="dash-split" viewBox="0 0 100 1" preserveAspectRatio="none" aria-label="Agent time split">'+times.map((value, index) => { const w = whole ? value/whole*100 : 0, x = x0; x0 += w; return '<rect class="dash-time-'+index+'" x="'+x+'" width="'+Math.max(0, w - (index < 2 && w ? 0.6 : 0))+'" height="1"/>'; }).join('')+'</svg>';
  const lastHour = m.bins.at(-1)?.count ?? 0, peak = Math.max(0, ...m.bins.map(bin => bin.count));
  const strip = section('Pace and agent time', 'dash-stripsec', label('Pace · 24 h'), '<div class="dash-card dash-strip"><span class="dash-grp">'+sub('Landed per hour')+(m.complete ? spark+'<span>'+open('<b class="g">'+lastHour+'/h</b>', 'landed', { title: 'Landed in the last hour' })+' now · '+open('<b>'+num(m.totals.day)+'</b>', 'landed', { title: 'Landed in the last 24 hours' })+' in the last 24 hours · peak <b>'+peak+'/h</b></span>' : '<span>Loading…</span>')+'</span>'
    + '<span class="dash-vr" aria-hidden="true"></span><span class="dash-grp">'+sub('Agent time · 4 h')+(m.complete ? split+'<span>building <b>'+share(0)+'%</b> · reviewing <b>'+share(1)+'%</b> · idle <b>'+share(2)+'%</b></span>' : '<span>Loading…</span>')+'</span></div>');

  // 5. Agents: one 25 px line per agent with its thin four-hour timeline, the inline stage chip and its numbers.
  const W = 600, at = t => (t - m.start)/14_400_000*W;
  // Every landing in the window, faint behind each agent's own segments, as on /live.
  // Drawn once and reused by every row, so a long table does not repeat each landing.
  const landingMarks = '<svg class="dash-defs" aria-hidden="true" width="0" height="0"><symbol id="dash-landings" viewBox="0 0 '+W+' 16" preserveAspectRatio="none">'+m.lists.landed.map(entry => '<rect x="'+at(entry.at)+'" y="3" width="1" height="10"/>').join('')+'</symbol></svg>';
  const landings = m.lists.landed.length ? '<use class="dash-landed" href="#dash-landings" width="'+W+'" height="16"/>' : '';
  const lane = agent => '<svg class="dash-lane" viewBox="0 0 '+W+' 16" preserveAspectRatio="none" aria-label="'+esc(agent.id)+' last four hours"><rect class="dash-track" x="0" y="7" width="'+W+'" height="2"/>'
    + [1,2,3].map(h => '<rect class="dash-tick" x="'+h*150+'" y="3" width="1" height="10"/>').join('') + landings
    + agent.segments.map(seg => '<rect class="'+(seg.kind === 'build' ? 'build' : 'review')+'" x="'+at(seg.start)+'" y="6" height="4" rx="1" width="'+Math.max(2, at(seg.end)-at(seg.start)-1)+'"><title>#'+seg.item+' '+(seg.kind === 'build' ? 'building' : 'reviewing')+' · '+Math.round((seg.end-seg.start)/60_000)+'m</title></rect>').join('')
    + (agent.shoutAt ?? []).map(t => '<rect class="dash-shout" x="'+at(t)+'" y="11" width="1.5" height="4"><title>shout</title></rect>').join('')
    + (agent.sentBack ?? []).map(event => '<rect class="dash-back" x="'+at(event.at)+'" y="2" width="2" height="12"><title>#'+event.item+' sent back</title></rect>').join('')+'</svg>';
  const chip = held => '<button type="button" class="dash-chip '+(held.kind === 'build' ? 'b' : 'r')+'" data-go="item:'+held.item.id+'"><span>#'+held.item.id+'</span>'+(held.kind === 'build' ? 'building' : 'reviewing')+' '+span(m.now - (held.since ?? m.now))+'</button>';
  const cell = value => '<td class="dash-num hide'+(value < 30_000 ? ' z' : '')+'">'+span(value)+'</td>';
  const agentRow = agent => { const held = agent.current[0];
    return '<tr data-dashboard-agent="'+esc(agent.id)+'"><td class="who" title="'+esc(agent.model ? agent.id+' · '+agent.model : agent.id)+'"><i class="dash-st '+(agent.group === 'building' ? 'b' : agent.group === 'reviewing' ? 'r' : '')+'"></i>'+esc(agent.name)+'</td><td class="tl">'+lane(agent)+'</td>'
      + '<td class="now">'+(held ? chip(held)+'<span class="tt">'+esc(held.item.title)+'</span>' : '<span class="tt q">Idle · '+span(m.now - agent.last)+'</span>')+'</td>'
      + cell(agent.build)+cell(agent.review)+cell(agent.idle)+'<td class="dash-num hide'+(agent.shouts ? '' : ' z')+'">'+agent.shouts+'</td></tr>'; };
  const group = (name, rows, list) => rows.length ? '<tr class="grp"><td colspan="7">'+name+' · '+open(num(rows.length), list)+'</td></tr>'+rows.map(agentRow).join('') : '';
  const building = m.agents.filter(agent => agent.group === 'building'), reviewers = m.agents.filter(agent => agent.group === 'reviewing');
  // Agents at work and not holding an item; seats quiet for 20 minutes are not at work and stay off the table.
  const quiet = m.agents.filter(agent => agent.group === 'between items');
  const quietRows = () => group('Idle', quiet, 'building');
  // With nobody building or reviewing, the idle seats are the table: they show at once, never behind a toggle (#7945).
  const onlyQuiet = !building.length && !reviewers.length;
  if (quiet.length && deferQuiet && !onlyQuiet) deferQuiet(quietRows);
  const longest = quiet.length ? span(Math.max(...quiet.map(agent => m.now - agent.last))) : '';
  const axis = new Date(m.start).toLocaleTimeString(locale, { timeZone, hour: 'numeric', minute: '2-digit' })+' → now';
  const legend = '<span class="dash-legend"><span><i class="build"></i>building</span><span><i class="review"></i>reviewing</span><span><i class="idle"></i>idle</span><span><i class="back"></i>sent back</span><span><i class="landed"></i>landed</span><span><i class="shout"></i>shout</span></span>';
  const agents = section('Agents', 'dash-agentsec', label('Agents', open(num(m.totals.working), 'building', { cls: 'dash-pill', title: 'Agents at work' })+' · 4 h'+(m.totals.joined ? ' · '+num(m.totals.joined)+' joined' : '')),
    '<div class="dash-card dash-agents">'+landingMarks
    + '<div class="dash-scroll"><table class="dash-agt"><thead><tr><th>Agent</th><th>'+esc(axis)+'</th><th>Now</th><th class="r hide">Build</th><th class="r hide">Review</th><th class="r hide">Idle</th><th class="r hide">Shouts</th></tr></thead>'
    + '<tbody>'+group('Building', building, 'building')+group('Reviewing', reviewers, 'review')+'</tbody>'
    + (quiet.length ? '<tbody data-dashboard-quiet-rows'+(onlyQuiet ? '' : ' hidden')+'>'+(deferQuiet && !onlyQuiet ? '' : quietRows())+'</tbody>' : '')+'</table></div>'
    + (quiet.length && !onlyQuiet ? '<button type="button" class="dash-more" data-dashboard-quiet aria-expanded="false">▸ <b>'+quiet.length+'</b>&nbsp;idle · up to '+longest+'</button>' : '')
    + (!m.complete ? '<p class="dash-empty">Complete history is loading; the timelines fill in when it arrives.</p>' : '')+'</div>', { id: 'dashboard-agents', cap: legend });

  // 6. The four lists: In the gate, In review, Accepted landing, Landed in 4 h.
  const late = 30 * 60_000;
  // An empty gate, review or landing list is one quiet line under its header, not a card with a placeholder inside.
  const list = (name, n, listKey, note, rows, foot = '', empty = 'Nothing '+name.toLowerCase()+'.') => !rows.length && listKey !== 'landed' ? section(name, 'dash-qsec dash-qquiet', label(esc(name), pill(n, listKey)), '', { cap: esc(empty) }) : section(name, 'dash-qsec', label(esc(name), pill(n, listKey)),
    '<div class="dash-card dash-q">'+(rows.length ? rows.slice(0, 10).join('') : '<p class="dash-empty">'+esc(empty)+'</p>')+'</div>', { cap: note, link: foot ? open(foot, listKey, { cls: 'dash-lk' }) : '' });
  const L = m.lists;
  /** One gate row: it opens the item's gate trace panel, which sits right under it and lists each phase with its duration in ms. */
  const gateRow = entry => {
    const shown = gate.open === entry.id, job = m.runners?.gates?.[entry.id];
    const button = '<button type="button" class="dash-row" data-gate-trace="'+entry.id+'" aria-expanded="'+shown+'"><span class="dash-id">#'+entry.id+'</span><span class="dash-t" title="'+esc(entry.title)+'">'+esc(entry.title)+'</span><span class="dash-age">gate '+ago(m.last(entry, 'submit'))+'</span></button>';
    if (!shown) return button;
    const trace = job ? gate.trace(job, { now: m.now }) : null, phases = trace ? trace.phases : [], total = Math.max(1, trace ? trace.totalMs : 1);
    const bar = phase => '<svg class="dash-gbar" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="100" height="1"/><rect class="'+phase.kind+'" x="'+((phase.start - trace.start)/total*100)+'" width="'+Math.max(0.6, phase.ms/total*100)+'" height="1"/></svg>';
    const line = phase => '<li class="dash-gp '+phase.kind+(phase.open ? ' now' : '')+'" data-gate-phase="'+esc(phase.name)+'"><span class="dash-gn">'+esc(phase.type === 'gap' ? 'gap' : phase.name)+(phase.open ? ' <small>running</small>' : '')+'</span>'+bar(phase)+'<span class="dash-gm">'+num(phase.ms)+' ms</span></li>';
    const status = !trace ? 'No gate record for this item yet.' : !phases.length ? 'The gate has not started a phase.' : trace.running ? 'Running · now in <b>'+esc(trace.current.name)+'</b> · '+num(trace.totalMs)+' ms so far' : 'Finished · '+num(trace.totalMs)+' ms in all, '+num(trace.gapMs)+' ms waiting between phases';
    return button+'<div class="dash-gt" data-gate-panel="'+entry.id+'" role="region" aria-label="Gate trace for #'+entry.id+'"><p class="dash-gs">'+status+'</p>'
      + (phases.length ? '<ol class="dash-gl">'+phases.map(line).join('')+'</ol>' : '')
      + '<p class="dash-gf"><button type="button" class="dash-lk" data-go="item:'+entry.id+'">Open the item ›</button><button type="button" class="dash-lk" data-gate-trace="'+entry.id+'">Close</button></p></div>';
  };
  const reviewed = L.review.filter(reserved).length;
  const queues = '<div class="dash-queues">'
    + list('In the gate', L.gate.length, 'gate', L.gate.length ? 'longest '+ago(m.last(L.gate[0], 'submit')) : '', L.gate.map(entry => gate ? gateRow(entry) : row('dash-row', entry, 'gate '+ago(m.last(entry, 'submit')))))
    + list('In review', L.review.length, 'review', L.review.length ? reviewed+' being reviewed · '+(L.review.length - reviewed)+' pending review' : '', L.review.map(entry => reserved(entry) ? row('dash-row', entry, 'reviewing '+ago(m.last(entry, 'reserve'))) : row('dash-row', entry, 'pending review '+ago(m.last(entry, 'submit')), m.now - m.last(entry, 'submit') > late)))
    + list('Landing', L.accepted.length, 'passed', L.accepted.length ? L.accepted.length+' accepted, landing next' : '', L.accepted.map((entry, index) => row('dash-row', entry, entry.landingBatchAt ? 'landing '+ago(Date.parse(entry.landingBatchAt) || m.now) : index ? 'next' : 'passed '+ago(m.last(entry, 'accept')))))
    + list('Landed · 4 h', L.landed.length, 'landed', '', L.landed.filter(entry => entry.item).map(entry => row('dash-row', entry.item, ago(entry.at))), L.landed.length ? 'All '+L.landed.length+' ›' : '', 'Nothing landed in the last 4 hours.')
    + '</div>';

  // 7. Your lanes: each lane's work now and its last four hours; the bar's width is capped by the busiest lane.
  const widest = Math.max(1, ...m.lanes.map(entry => (entry.landed ?? 0) + entry.review + entry.building));
  const mini = entry => { let x = 0; const seg = (value, cls) => { const w = value/widest*100; const out = value ? '<rect class="'+cls+'" x="'+x+'" width="'+Math.max(0.6, w - 0.4)+'" height="1"/>' : ''; x += w; return out; };
    return '<svg class="dash-mbar" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><rect class="dash-mbar-bg" width="100" height="1"/>'+seg(entry.landed ?? 0, 'landed')+seg(entry.review, 'review')+seg(entry.building, 'building')+'</svg>'; };
  const laneCell = (value, listKey, laneName, cls = '') => '<td class="dash-num '+cls+(value ? '' : ' z')+'">'+(value === null ? '—' : open(num(value), listKey, { lane: laneName }))+'</td>';
  const lanes = section('Your lanes', 'dash-lanesec', label('Lanes', pill(m.lanes.length, 'active')+' · 4 h'), '<div class="dash-card dash-lanes"><table class="dash-tbl"><thead><tr><th>Lane</th><th class="r">Building</th><th class="r">Review</th><th class="r">Ready</th><th class="r">Landed</th><th class="r hide">Sent back</th><th class="mini"></th></tr></thead><tbody>'
    + m.lanes.map(entry => '<tr><td class="ln">'+esc(entry.lane)+'</td>'+laneCell(entry.building, 'building', entry.lane)+laneCell(entry.review, 'review', entry.lane)+laneCell(entry.ready, 'next', entry.lane)+laneCell(entry.landed, 'landed', entry.lane, 'ink')+laneCell(entry.sentBack, 'sent-back', entry.lane, 'hide'+(entry.sentBack ? ' back' : ''))+'<td class="mini">'+mini(entry)+'</td></tr>').join('')
    + '</tbody></table></div>', { cap: 'Landed and sent back: 4 h; the rest now' });

  // 8. Runners: each runner's load and jobs, what the busiest one runs, and the runs in flight.
  const runners = (() => {
    const live = m.runners, list = Array.isArray(live?.runners) ? live.runners : [];
    const settings = '<button type="button" class="dash-lk" data-tab="settings">Settings ›</button>';
    if (!list.length) return section('Runners', 'dash-runsec', label('Runners', '<span class="dash-pill static" data-count="runners">'+(m.totals?.runners ?? 0)+'</span>'), '<div class="dash-card dash-runners"><div class="dash-l"><p class="dash-empty">No runner reports to this board.</p></div></div>', { link: settings });
    const busy = list.filter(runner => runner.busy).length, jobs = list.reduce((sum, runner) => sum + runner.jobs.length, 0);
    const pick = list.toSorted((a, b) => b.jobs.length - a.jobs.length || (b.cpu ?? 0) - (a.cpu ?? 0))[0];
    const load = cpu => '<svg class="dash-load" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="100" height="1"/>'+(Number.isFinite(cpu) ? '<rect class="'+(cpu >= 90 ? 'hot' : cpu >= 70 ? 'hi' : '')+'" width="'+Math.min(100, cpu)+'" height="1"/>' : '')+'</svg>';
    const pct = value => Number.isFinite(value) ? value+'%' : '—';
    // A registered runner reads by its name; one with no fresh heartbeat reads 'offline', never a bare dash (#8060).
    const named = runner => esc(runner.name ?? 'Runner '+runner.runner);
    const cpuCell = runner => runner.offline ? 'offline' : pct(runner.cpu);
    const slots = n => '<span class="dash-slots">'+Array.from({ length: Math.min(n, 8) }, () => '<i></i>').join('')+'<em>'+n+'</em></span>';
    const table = '<table class="dash-tbl"><thead><tr><th>Runner</th><th class="loadh">Load</th><th class="r">CPU</th><th class="r hide">RAM</th><th>Jobs</th></tr></thead><tbody>'
      + list.map(runner => '<tr class="'+(runner === pick ? 'sel' : '')+'"><td class="mono">'+named(runner)+'</td><td>'+load(runner.cpu)+'</td><td class="dash-num ink'+(runner.cpu >= 90 ? ' back' : '')+'">'+cpuCell(runner)+'</td><td class="dash-num hide">'+(runner.offline ? 'offline' : pct(runner.ram))+'</td><td>'+slots(runner.jobs.length)+'</td></tr>').join('')+'</tbody></table>';
    // Every run reads the same way: the item id when it has one, the kind, then files done of total (#7403).
    const job = entry => '<div class="dash-j"><span class="dash-id">'+(entry.item ? '#'+entry.item : '')+'</span><span class="dash-t">'+esc(entry.kind ?? 'job')+(entry.selected ? ' <small>· '+(entry.done ?? 0)+' of '+entry.selected+(entry.selected === 1 ? ' file' : ' files')+'</small>' : '')+'</span><span class="dash-age'+(entry.failing ? ' late' : '')+'">'+(entry.failing ? entry.failing+' red' : entry.minutesLeft !== null && entry.minutesLeft !== undefined ? entry.minutesLeft+'m left' : '')+'</span></div>';
    const runs = Array.isArray(live.runs) ? live.runs : [];
    const kinds = kind => runs.filter(run => run.kind === kind).length;
    // Runs that finished in the last four hours, so a runner that ran jobs never reads as one that ran none (#7945).
    const done = live.finished ?? {}, ranTotal = ['gate', 'landing', 'test'].reduce((sum, key) => sum + (Number.isInteger(done[key]) ? done[key] : 0), 0);
    const ran = ranTotal ? [['gate', 'gates'], ['landing', 'landings'], ['test', 'tests']].filter(([key]) => done[key] > 0).map(([key, word]) => done[key]+' '+word).join(', ') : '';
    return section('Runners', 'dash-runsec', label('Runners', '<span class="dash-pill static" data-count="runners">'+(m.totals?.runners ?? list.length)+'</span>'), '<div class="dash-card dash-runners"><div class="dash-l">'
      + '<p class="dash-sub"><b>'+jobs+'</b> jobs on <b>'+busy+'</b> of '+list.length+' runners</p>'+table+'</div>'
      + '<div class="dash-node"><h3>'+named(pick)+'<small>busiest</small></h3><p class="dash-facts"><b>'+cpuCell(pick)+'</b> CPU · <b>'+(pick.offline ? 'offline' : pct(pick.ram))+'</b> RAM · <b>'+pick.jobs.length+'</b> jobs</p>'
      + sub('Running here · '+pick.jobs.length)+(pick.jobs.length ? pick.jobs.map(job).join('') : '<p class="dash-empty">Nothing running.</p>')
      + sub('In flight, all runners')+(runs.length ? runs.slice(0, 4).map(run => job({ ...run, item: run.item })).join('') : '<p class="dash-empty">'+(ran ? 'None in flight. Ran in the last 4 hours: '+ran+'.' : 'No runs.')+'</p>')+'</div>'
      + '<div class="dash-rfoot"><span><b>'+kinds('gate')+'</b> gates<small>running now</small></span><span><b>'+kinds('landing')+'</b> landings<small>running now</small></span><span><b>'+(runs.length - kinds('gate') - kinds('landing'))+'</b> tests<small>running now</small></span></div></div>', { cap: busy+' busy', link: settings });
  })();

  return '<div class="dash-live">'+flowHtml + now + shipping + strip + agents + queues + lanes + runners+'<p class="dash-footnote">Every number opens the items it counts.</p></div>';
}
