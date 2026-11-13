/**
 * Render the approved Dashboard; all numbers come from its snapshot model, never mockup values [N26].
 * @param {object} model - The Dashboard snapshot model.
 * @param {object} options - Prepared person-facing cards and presentation settings.
 * @param {string} options.needs - Shared Needs-you markup.
 * @param {string} options.needsHeader - Compact Needs navigation above its rows.
 * @returns {string} Dashboard markup.
 */
export function dashboardHtml(model, { needs = '', needsHeader = '', progress = '', stagePresentation = null, when = null, deferQuiet, floorHref = null, locale = 'en-US', timeZone = 'UTC' } = {}) {
  const m = model;
  /** Escape both text and attribute values supplied by a board. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  /** Approved mockup symbols stay inline so the standalone view needs no sprite request. */
  const icon = name => {
    const paths = {
      clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
      land: '<path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10"/>',
      pass: '<circle cx="8" cy="8" r="5.5"/><path d="M5.6 8.2l1.7 1.6 3.2-3.4"/>',
      back: '<path d="M6 4L2.5 7.5 6 11M2.5 7.5H10a3.5 3.5 0 0 1 0 7H8"/>',
      msg: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
      build: '<path d="M9.5 2.5l4 4-1.5 1.5-4-4zM8 4L2.5 9.5l4 4L12 8"/>',
      review: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
      dots: '<path d="M4 8h.01M8 8h.01M12 8h.01"/>',
      ready: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 6h5M5.5 9h3"/>',
      bolt: '<path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/>',
      flag: '<path d="M3.5 14V2.5M3.5 3h8l-1.5 3 1.5 3h-8"/>',
    };
    return '<svg class="dash-icon" data-dashboard-icon="'+name+'" aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+paths[name]+'</svg>';
  };
  /** Format actual elapsed minutes without a made-up lower bound. */
  const age = at => { const minutes = Math.max(0, Math.floor((m.now-at)/60_000)); return minutes < 60 ? minutes+'m' : (minutes/60).toFixed(1)+'h'; };
  /** Use the shared browser clock, or explicit locale and zone for standalone rendering. */
  const stamp = when ?? (at => new Date(at).toLocaleString(locale, { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  /** A native item navigation target shares the existing cockpit dispatcher. */
  /** Render each Dashboard destination with its shared stage, detail and marks. */
  const item = entry => {
    const stage = stagePresentation?.(entry, { gated: Boolean(entry.blockedBy?.length || entry.heldReason || entry.laneHoldReason), landingBatchAt: entry.landingBatchAt ? stamp(entry.landingBatchAt) : null,
      withdrawnFrom: entry.withdrawnFrom, gateDetail: entry.withdrawnReason || '' });
    const marks = [
      entry.heldReason ? '<span class="stage-mark gate" title="Held: '+esc(entry.heldReason)+'" aria-label="Held: '+esc(entry.heldReason)+'">Held</span>' : '',
      entry.laneHoldReason ? '<span class="stage-mark gate" title="Lane held: '+esc(entry.laneHoldReason)+'" aria-label="Lane held: '+esc(entry.laneHoldReason)+'">Lane held</span>' : '',
      entry.verdict?.decision === 'REJECT' && entry.status !== 'verified' ? '<span class="stage-mark no" title="Sent back: '+esc([entry.verdict.reason, entry.verdict.note].filter(Boolean).join(': '))+'" aria-label="Sent back: '+esc([entry.verdict.reason, entry.verdict.note].filter(Boolean).join(': '))+'">Sent back</span>' : '',
      entry.verdictState?.code === 'STALE_VERDICT' ? '<span class="stage-mark" title="Stale: '+esc(entry.verdictState.reason || 'main changed '+(entry.verdictState.file || 'a reviewed file'))+'" aria-label="Stale: '+esc(entry.verdictState.reason || 'main changed '+(entry.verdictState.file || 'a reviewed file'))+'">Stale</span>' : '',
      entry.status === 'withdrawn' ? '<span class="stage-mark no" title="Withdrawn: '+esc(entry.withdrawnReason || 'reason unavailable')+'" aria-label="Withdrawn: '+esc(entry.withdrawnReason || 'reason unavailable')+'">Withdrawn</span>' : '',
    ].filter(Boolean).join('');
    const status = stage ? '<span class="item-stage" data-stage="'+esc(stage.stage.toLowerCase().replace(/\s+/gu, '-'))+'"><span class="stage-line"><b class="stage-word">'+esc(stage.stage)+'</b>'+marks+'</span><small class="stage-detail">'+esc(stage.detail)+'</small></span>' : '';
    return '<button class="dash-item" type="button" data-go="item:'+entry.id+'"><span>#'+entry.id+'</span><span class="dash-item-copy"><b>'+esc(entry.title)+'</b>'+status+'</span></button>';
  };
  /** Keep section labels accessible even when the section has no work. */
  const card = (title, html, classes = '') => '<section class="dash-card '+classes+'" aria-label="'+esc(title)+'"><h2>'+esc(title)+'</h2>'+html+'</section>';
  /** Unknown history is explicitly loading/unavailable rather than a zero. */
  const count = value => value === null || value === undefined ? '—' : value.toLocaleString(locale);
  /** A four-hour hero chip: always a number, 0 when none; a count the board could not read says why on hover, never a dash. */
  const heroChip = ([key,label,symbol,source]) => {
    const value = m.totals[key];
    if (Number.isInteger(value)) return '<span title="'+source+'" data-dashboard-recent="'+key+'" data-value="'+value+'">'+icon(symbol)+'<b>'+value.toLocaleString(locale)+'</b> '+label+'</span>';
    const why = m.unread || 'The board has not sent this count.';
    return '<span class="dash-unread" title="'+esc(label+' in the last 4 hours is not read yet: '+why)+'" data-dashboard-recent="'+key+'" data-value="">'+icon(symbol)+label+' · not read yet</span>';
  };
  const six = m.pace ? m.pace.last6h/6 : null, two = m.pace ? m.pace.last2h/2 : null;
  const hero = '<section class="dash-card dash-hero"><div><h1 title="Agents building, reviewing, or between items in the current board snapshot">'+m.totals.working+(m.totals.working===1?' agent at work.':' agents at work.')+'</h1><p class="dash-accent" title="Items landed during the last 24 hours">'+count(m.totals.day)+' landed in the last 24 hours.</p><div class="dash-chips"><span>'+icon('clock')+'Last 4 hours</span>'+[['recent','landed','land','Items landed during the last 4 hours'],['passed','passed review','pass','Recorded review acceptances during the last 4 hours'],['sentBack','sent back to fix','back','Recorded rejections and reopenings during the last 4 hours'],['shouts','shouts to you','msg','Shouts addressed to you during the last 4 hours']].map(heroChip).join('')+'</div></div><div class="dash-rate" title="Recorded item landings: hourly pace over the last 6 and 2 hours, and the all-time total"><b data-dashboard-stat="pace6" data-value="'+esc(six)+'">'+(six===null?'—':six.toFixed(1))+'</b> items an hour<small>today’s pace, the last 6 hours</small><small>'+(two===null?'—':two.toFixed(1))+' /h last 2 h · '+count(m.totals.allTime)+' landed all time</small></div><span class="visually-hidden" data-dashboard-stat="building" data-value="'+m.claims.length+'">'+m.claims.length+' building</span></section>';
  const needsCard = '<section class="dash-card needs-card" aria-label="Rulings"><header class="needs-card-header"><h2>Rulings</h2>'+needsHeader+'</header>' + (needs ? '<ol class="needs home-needs">'+needs+'</ol>' : needsHeader ? '' : '<p><b>No rulings are waiting.</b> When a decision is yours, it shows up here and on your phone.</p>') + '</section>';
  /** Where the work is: five step cards joined by arrows, with the sent-back loop from In review back to Building; each opens Items filtered to its step. */
  const flowCard = (() => {
    const reserved = m.reviewing.filter(entry => entry.reviewer && Date.parse(entry.reviewUntil) > m.now).length;
    const steps = [['ready','next','Ready',m.next.length,(m.stageCounts?.gated ?? 0).toLocaleString(locale)+' more wait on others','Open the ready items, in rank order'],
      ['building','building','Building',m.claims.length,'one item per agent','Open the items being built'],
      ['review','review','In review',m.reviewing.length,reserved.toLocaleString(locale)+' being checked now','Open the items in review, oldest first'],
      ['passed','passed','Passed',m.landing.length,'landing next','Open the items that passed review and wait to land'],
      ['landed','landed','Landed',m.totals.day ?? m.landed.length,'in the last 24 hours','Open the landed items']];
    const back = m.totals.sentBack;
    return '<section class="dash-card dash-flow" aria-label="Where the work is"><header class="dash-flow-head"><h2>Where the work is</h2><span>Every item on the board, now. Click a step to open its items.</span></header><div class="dash-steps">'
      + steps.map(([key,list,label,value,caption,title]) => '<button class="dash-step '+key+'" type="button" data-dashboard-step="'+key+'" data-dashboard-list="'+list+'" title="'+esc(title)+'"><span class="dash-step-name">'+icon(key==='ready'?'ready':key==='building'?'build':key==='review'?'review':key==='passed'?'pass':'land')+label+'</span><b>'+value.toLocaleString(locale)+'</b><small>'+esc(caption)+'</small></button>').join('')
      + '</div><div class="dash-loop" data-dashboard-loop><span class="dash-loop-line" aria-hidden="true"></span><span class="dash-loop-label" title="Recorded rejections and reopenings during the last 4 hours">'+icon('back')+'<span>'+(Number.isInteger(back)?'<b>'+back.toLocaleString(locale)+'</b> ':'')+'sent back to fix in 4 h</span><span class="dash-loop-note">· a different agent reviews every item</span></span></div></section>';
  })();
  /** Current holding actors and elapsed stays come from the same claims as the headline. */
  /** In flight: one column of two-line rows, id and title over who holds it and for how long; no status pills (mockup). */
  const flight = (label, entries, kind) => {
    /** A real in-flight row; the holder line reads the same claim and review fields as the Agents table. */
    const line = entry => '<li><button class="dash-flight-row" type="button" data-go="item:'+entry.id+'"><span class="dash-flight-title"><span>#'+entry.id+'</span><b title="'+esc(entry.title)+'">'+esc(entry.title)+'</b></span><small>'+esc(kind==='claim'?entry.owner:entry.reviewer||'waiting for a reviewer')+(kind==='claim'||entry.reviewer?' · '+age(m.last(entry,kind)):'')+'</small></button></li>';
    return '<div class="dash-flight '+(kind==='claim'?'building':'review')+'"><h3>'+icon(kind==='claim'?'build':'review')+label+' <span>'+entries.length+'</span></h3><ul>'+entries.slice(0,4).map(line).join('')+'</ul>'+(entries.length>4?'<details data-dashboard-disclosure="'+kind+'"><summary>Show '+(entries.length-4)+' more</summary><ul>'+entries.slice(4).map(line).join('')+'</ul></details>':'')+'</div>';
  };
  /** Shipping now: the release name in the body face, N to go, one stage bar with its legend, In flight, then three pace tiles. */
  const shipping = (() => {
    const release = m.milestone, summary = release?.summary;
    const counted = key => Number.isInteger(summary?.[key]) && summary[key] >= 0;
    if (!release || !counted('total') || !counted('left')) return '<section class="dash-card dash-shipping dash-release-card" aria-label="Shipping now"><h2>Shipping now</h2><p>No release is in progress.</p></section>';
    const named = /^(\d+(?:\.\d+)+)\s*:\s*(.+)$/u.exec(String(release.name ?? ''));
    const title = named ? '<span class="dash-release-version">'+esc(named[1])+'</span>'+esc(named[2]) : esc(release.name);
    // The formal stage colours: green landed, striped landing, yellow review, blue building, purple waiting, grey held.
    const parts = [['landed','landed'],['landing','passed, landing'],['review','in review'],['building','building'],['waiting','waiting'],['held','held']].filter(([key]) => counted(key));
    // SVG geometry, not inline styles, which the view's policy disallows; each segment is its count in SVG units.
    let offset = 0;
    const bar = '<svg class="dash-release-bar" viewBox="0 0 '+(summary.total || 1)+' 1" preserveAspectRatio="none" role="img" aria-label="'+esc(release.name+': '+parts.map(([key,label]) => summary[key]+' '+label).join(', '))+'">'+parts.filter(([key]) => summary[key]).map(([key,label]) => { const x = offset; offset += summary[key]; return '<rect class="dash-release-'+key+'" data-release-segment="'+key+'" data-count="'+summary[key]+'" x="'+x+'" width="'+summary[key]+'" height="1"><title>'+summary[key]+' '+label+'</title></rect>'; }).join('')+'</svg>';
    const keys = '<div class="dash-release-keys">'+parts.map(([key,label]) => '<span data-release-key="'+key+'"><i class="dash-release-'+key+'" aria-hidden="true"></i><b>'+summary[key].toLocaleString(locale)+'</b> '+label+'</span>').join('')+'</div>';
    const pace = summary.pace ?? m.pace, measured = Number.isInteger(pace?.last6h) && Number.isInteger(pace?.last2h);
    const hour = at => new Date(at).toLocaleTimeString(locale, { timeZone, hour: 'numeric' });
    const day = at => new Date(at).toLocaleDateString(locale, { timeZone, weekday: 'long' });
    const estimate = summary.estimate, ranged = estimate && Number.isFinite(estimate.low) && Number.isFinite(estimate.high);
    const lo = ranged ? Math.round(estimate.low) : null, hi = ranged ? Math.round(estimate.high) : null;
    const when = !ranged ? (summary.reason === 'few-landings' ? 'too few landings yet to estimate' : 'completion time unavailable')
      : lo === hi ? day(m.now+lo*3_600_000)+', around '+hour(m.now+lo*3_600_000)
        : day(m.now+lo*3_600_000) === day(m.now+hi*3_600_000) ? day(m.now+lo*3_600_000)+', '+hour(m.now+lo*3_600_000)+' to '+hour(m.now+hi*3_600_000)
          : day(m.now+lo*3_600_000)+' '+hour(m.now+lo*3_600_000)+' to '+day(m.now+hi*3_600_000)+' '+hour(m.now+hi*3_600_000);
    const tile = (key, symbol, label, value, unit, note) => '<div class="dash-tile '+key+'" data-dashboard-tile="'+key+'"><span class="dash-tile-key">'+icon(symbol)+label+'</span><span class="dash-tile-value"><b>'+value+'</b>'+(unit?'<span>'+unit+'</span>':'')+'</span><small>'+esc(note)+'</small></div>';
    const tiles = '<div class="dash-tiles">'
      + tile('today', 'bolt', 'Today’s pace', measured ? (pace.last6h/6).toFixed(1) : '0.0', 'items an hour', (measured ? pace.last6h : 0)+' landed in the last 6 hours')
      + tile('now', 'clock', 'Right now', measured ? (pace.last2h/2).toFixed(1) : '0.0', 'items an hour', (measured ? pace.last2h : 0)+' landed in the last 2 hours')
      + tile('eta', 'flag', 'Done at this pace', ranged ? (lo === hi ? lo : lo+'–'+hi)+' h' : 'Not yet', '', when)
      + '</div>';
    return '<section class="dash-card dash-shipping dash-release-card" aria-label="Shipping now"><div class="dash-release-head"><div><h2>Shipping now</h2><p class="dash-release-name">'+title+'</p></div>'
      + '<p class="dash-release-left"><b>'+summary.left.toLocaleString(locale)+' to go</b><span>'+(counted('landed') ? summary.landed.toLocaleString(locale) : 0)+' of '+summary.total.toLocaleString(locale)+' landed</span></p></div>'
      + bar + keys
      + '<div class="dash-inflight"><h3>In flight <span>'+(m.inFlight.building.length+m.inFlight.review.length)+'</span></h3><div class="dash-inflight-cols">'+flight('Building',m.inFlight.building,'claim')+flight('In review',m.inFlight.review,'submit')+'</div></div>'
      + tiles + '</section>';
  })();
  const maximum = Math.max(1,...m.bins.map(bin=>bin.count),six??0), chartHeight = 100;
  const hourLabel = at => new Date(at).toLocaleTimeString(locale, { timeZone, hour: 'numeric' });
  const paceY = chartHeight-(six??0)/maximum*90;
  const bars = '<div class="dash-chart">'+(six===null?'':'<span class="dash-pace-tag">'+six.toFixed(1)+'/h today</span>')+'<svg viewBox="0 0 960 120" preserveAspectRatio="none" role="img" aria-label="Items landed per hour, last 24 hours">'+m.bins.map((bin,index)=>'<rect tabindex="0" x="'+(index*40+4)+'" y="'+(chartHeight-bin.count/maximum*90)+'" width="30" height="'+Math.max(1,bin.count/maximum*90)+'" rx="2"><title>'+esc(new Date(bin.from).toLocaleString(locale, { timeZone }))+' – '+esc(new Date(bin.to).toLocaleTimeString(locale, { timeZone }))+': '+bin.count+' landed</title></rect>').join('')+(six===null?'':'<line class="dash-pace-line" x1="720" x2="960" y1="'+paceY+'" y2="'+paceY+'"><title>'+six.toFixed(1)+' items an hour over the last 6 hours</title></line>')+'</svg>'+'</div><div class="dash-axis">'+[0,6,12,18,24].map(h=>'<span>'+esc(h===24?'now':hourLabel(m.now-(24-h)*3_600_000))+'</span>').join('')+'</div><p class="dash-chart-caption">'+count(m.totals.day)+' in 24 h · busiest hour '+Math.max(0,...m.bins.map(bin=>bin.count))+'</p>';
  const activeAgents = m.agents.filter(agent=>agent.last>m.start||agent.current.length);
  const totals = ['build','review','idle'].map(key=>activeAgents.reduce((sum,agent)=>sum+agent[key],0)), total = totals.reduce((sum,value)=>sum+value,0);
  const split = '<svg class="dash-split" viewBox="0 0 '+(total||1)+' 1" preserveAspectRatio="none" aria-label="Agent time split">'+totals.map((value,index)=>'<rect class="dash-time-'+index+'" x="'+totals.slice(0,index).reduce((sum,v)=>sum+v,0)+'" y="0" width="'+value+'" height="1"/>').join('')+'</svg>'+['Building','Reviewing','Between items'].map((label,index)=>'<p class="dash-time-key"><span>'+label+'</span><b>'+(total?Math.round(totals[index]/total*100):0)+'%</b><span>'+(totals[index]/3_600_000).toFixed(1)+' h</span></p>').join('');
  /** Each SVG interval has a real event-derived item and duration tooltip. */
  /** Keep zero explicit and every positive sub-hour duration visible at minute precision. */
  const agentDuration = milliseconds => {
    if (milliseconds === 0) return '0m';
    if (milliseconds < 60_000) return '<1m';
    if (milliseconds < 3_600_000) return Math.floor(milliseconds/60_000)+'m';
    return (milliseconds/3_600_000).toFixed(1)+'h';
  };
  const agentRow = agent => '<div class="dash-agent" data-dashboard-agent="'+esc(agent.id)+'"><b title="'+esc(agent.model?agent.id+' · '+agent.model:agent.id)+'">'+icon(agent.group==='building'?'build':agent.group==='reviewing'?'review':'dots')+esc(agent.name)+'</b><svg viewBox="0 0 400 20" preserveAspectRatio="none" aria-label="'+esc(agent.id)+' last four hours"><path class="dash-track" d="M0 10H400"/>'+[1,2,3].map(index=>'<path class="dash-tick" d="M'+index*100+' 3V17"/>').join('')+agent.segments.map(segment=>'<rect class="'+segment.kind+'" x="'+((segment.start-m.start)/14_400_000*400)+'" y="4" height="12" width="'+Math.max(1,(segment.end-segment.start)/14_400_000*400)+'" rx="2"><title>#'+segment.item+' '+esc(segment.kind==='build'?'building':'reviewing')+' · '+((segment.end-segment.start)/60_000).toFixed(0)+'m</title></rect>').join('')+(agent.sentBack??[]).map(event=>'<rect class="dash-sent-back" x="'+((event.at-m.start)/14_400_000*400)+'" y="1" height="18" width="3"><title>#'+event.item+' sent back</title></rect>').join('')+'</svg><span class="dash-agent-now">'+(agent.current.length?agent.current.map(held=>item(held.item)).join(''):'between items')+'</span><span class="dash-agent-number">'+agentDuration(agent.build)+'</span><span class="dash-agent-number">'+agentDuration(agent.review)+'</span><span class="dash-agent-number">'+agent.shouts+'</span></div>';
  const groups = ['building','reviewing','between items'];
  const quiet = m.agents.filter(agent=>agent.group==='quiet');
  /** Defer only a closed disclosure's real rows; its current-model closure retains every field. */
  const quietRows = () => quiet.map(agentRow).join('');
  if (quiet.length && deferQuiet) deferQuiet(quietRows);
  const legend = '<div class="dash-agent-legend">'+[['build','building'],['review','reviewing'],['back','sent back']].map(([symbol,label])=>'<span>'+icon(symbol)+label+'</span>').join('')+'</div>';
  const agents = card('Agents',legend+'<div class="dash-agent-axis"><span>Agent</span><span>'+[4,3,2,1].map(h=>'<span>'+esc(hourLabel(m.now-h*3_600_000))+'</span>').join('')+'</span><span>Now</span><span>Build</span><span>Review</span><span>Shouts</span></div>'+groups.map(group=>{const rows=m.agents.filter(agent=>agent.group===group);return rows.length?'<h3 class="dash-agent-group label">'+esc(group.toUpperCase())+' · '+rows.length+'</h3>'+rows.map(agentRow).join(''):'';}).join('')+(quiet.length?'<details data-dashboard-disclosure="quiet"><summary>'+quiet.length+' quiet agents · nothing in the last 20 minutes</summary>'+'<div data-dashboard-quiet-rows>'+ (deferQuiet ? '' : quietRows())+'</div></details>':'')+(!m.complete?'<p class="muted">Complete history is loading; historical totals are not yet available.</p>':'')+(floorHref?'<a class="link dash-floor-link" href="'+esc(floorHref)+'" data-tab="dashboard" data-detail="floor">Open the agent floor →</a>':'')).replace('<h2>Agents</h2>',floorHref?'<h2 class="dash-agents-head"><a href="'+esc(floorHref)+'" data-tab="dashboard" data-detail="floor" title="Open the agent floor">Agents</a><a class="dash-agents-count" href="'+esc(floorHref)+'" data-tab="dashboard" data-detail="floor" title="Open the agent floor">'+m.totals.working+' working</a></h2>':'<h2 class="dash-agents-head">Agents<span class="dash-agents-count">'+m.totals.working+' working</span></h2>');
  return hero+needsCard+shipping+flowCard+'<div class="dash-two">'+card('Landed per hour',m.complete?bars:'<p>Loading complete landing history…</p>')+card('Agent time',m.complete?split:'<p>Loading complete agent history…</p>')+'</div>'+agents;
}
