/**
 * Render the approved Dashboard; all numbers come from its snapshot model, never mockup values [N26].
 * @param {object} model - The Dashboard snapshot model.
 * @param {object} options - Prepared person-facing cards and presentation settings.
 * @param {string} options.needs - Shared Needs-you markup.
 * @param {string} options.rules - Rules-card markup retained from the retired Home pane.
 * @param {string} options.needsHeader - Compact Needs navigation above its rows.
 * @param {string} options.capacity - Capacity-card markup retained from the retired Home pane.
 * @returns {string} Dashboard markup.
 */
export function dashboardHtml(model, { needs = '', needsHeader = '', progress = '', rules = '', capacity = '', stagePresentation = null, when = null, deferQuiet, floorHref = null, locale = 'en-US', timeZone = 'UTC' } = {}) {
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
      check: '<path d="M3 8.5l3.2 3L13 4.5"/>',
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
  const six = m.pace ? m.pace.last6h/6 : null, two = m.pace ? m.pace.last2h/2 : null;
  const hero = '<section class="dash-card dash-hero"><div><h1 title="Agents building, reviewing, or between items in the current board snapshot">'+m.totals.working+(m.totals.working===1?' agent at work.':' agents at work.')+'</h1><p class="dash-accent" title="Items landed during the last 24 hours">'+count(m.totals.day)+' landed in the last 24 hours.</p><div class="dash-chips"><span>'+icon('clock')+'Last 4 hours</span>'+[['recent','landed','land','Items landed during the last 4 hours'],['passed','passed review','pass','Recorded review acceptances during the last 4 hours'],['sentBack','sent back to fix','back','Recorded rejections and reopenings during the last 4 hours'],['shouts','shouts to you','msg','Shouts addressed to you during the last 4 hours']].map(([key,label,symbol,source])=>'<span title="'+source+'">'+icon(symbol)+count(m.totals[key])+' '+label+'</span>').join('')+'</div></div><div class="dash-rate" title="Recorded item landings: hourly pace over the last 6 and 2 hours, and the all-time total"><b data-dashboard-stat="pace6" data-value="'+esc(six)+'">'+(six===null?'—':six.toFixed(1))+'</b> items an hour<small>today’s pace, the last 6 hours</small><small>'+(two===null?'—':two.toFixed(1))+' /h last 2 h · '+count(m.totals.allTime)+' landed all time</small></div><span class="visually-hidden" data-dashboard-stat="building" data-value="'+m.claims.length+'">'+m.claims.length+' building</span></section>';
  // With nothing for the person, Needs you is one quiet line; otherwise its header and closed rows.
  const needsCard = needs || needsHeader
    ? '<section class="dash-card needs-card" aria-label="Needs you"><header class="needs-card-header"><h2>Needs you</h2>'+needsHeader+'</header>' + (needs ? '<ol class="needs home-needs">'+needs+'</ol>' : '') + '</section>'
    : '<section class="dash-card needs-card needs-quiet" aria-label="Needs you"><span class="needs-quiet-badge">'+icon('check')+'</span><p><b>Nothing needs you.</b> <span class="needs-quiet-note">When a decision is yours, it shows up here and on your phone.</span></p></section>';
  /** One compact strip of the seven pipeline stages and their counts, each linking to Items > Pipeline; no rows, no durations. */
  const stageStrip = m.stageCounts ? '<section class="dash-card dash-stage-strip" aria-label="Pipeline"><h2>Pipeline</h2><div class="dash-chips">'+[['gated','Gated'],['ready','Ready'],['building','Building'],['in-review','In review'],['verified','Verified'],['landing','Landing'],['merged','Merged']].map(([key,label]) => '<a class="dash-stage-link" href="#items/pipeline" data-dashboard-stage="'+key+'"><span>'+label+'</span> <b>'+count(m.stageCounts[key] ?? 0)+'</b></a>').join('')+'</div></section>' : '';
  const rulesCard = rules ? '<section id="dashboard-rules" class="dash-card" aria-label="Your rules">'+rules+'</section>' : '';
  const capacityCard = capacity ? '<section id="dashboard-capacity" class="dash-card" aria-label="Useful agents">'+capacity+'</section>' : '';
  /** Current holding actors and elapsed stays come from the same claims as the headline. */
  const flight = (label, entries, kind) => {
    /** Render a real in-flight row without changing its holding state. */
    const line = entry => '<li>'+item(entry)+'<small>'+esc(kind==='claim'?entry.owner:entry.reviewer||'waiting for a reviewer')+(kind==='claim'||entry.reviewer?' · '+age(m.last(entry,kind)):'')+'</small></li>';
    return '<div class="dash-flight"><h3>'+label+' '+entries.length+'</h3><ul>'+entries.slice(0,4).map(line).join('')+'</ul>'+(entries.length>4?'<details data-dashboard-disclosure="'+kind+'"><summary>Show '+(entries.length-4)+' more</summary><ul>'+entries.slice(4).map(line).join('')+'</ul></details>':'')+'</div>';
  };
  const shipping = '<section class="dash-card dash-shipping dash-release-card" aria-label="Shipping now">'
    + (m.milestone ? progress+'<h3>In flight</h3><div class="dash-two">'+flight('Building',m.inFlight.building,'claim')+flight('In review',m.inFlight.review,'submit')+'</div>'
      : '<p>No release is in progress.</p>') + '</section>';
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
  const landing = card('Landing now', m.landing.length?'<ul class="dash-list">'+m.landing.map(entry=>'<li>'+item(entry)+'<small>'+esc(entry.builtBy||'unknown builder')+' · '+esc(entry.verifiedBy||'unknown reviewer')+' · passed '+age(m.last(entry,'accept'))+' ago</small></li>').join('')+'</ul>':'<p>No accepted items are waiting to land.</p>');
  /** Complete list links reuse the established item filters and Activity tab. */
  const listCard = (title, entries, footer, target) => card(title,'<ul class="dash-list">'+entries.slice(0,8).map(({entry,at})=>'<li>'+item(entry)+'<small'+(title==='In review'&&m.now-at>3_600_000?' class="dash-old"':'')+'>'+age(at)+'</small></li>').join('')+'</ul><button type="button" class="link" '+target+'>'+esc(footer)+' →</button>');
  /** Render only canonical API scalars; the Dashboard never reconstructs their lifecycle or idle causes. */
  const comparison = () => {
    const observed = m.comparison;
    if (!observed) return '';
    if (!observed.available) return card('Window comparison', '<p>'+esc(observed.reason || 'Comparison unavailable')+'</p>');
    const { current, previous, change } = observed;
    /** Missing evidence stays visibly unmeasured, and share changes use absolute percentage points. */
    const figure = (value, share = false, delta = false) => value === null || value === undefined ? 'unmeasured'
      : (delta && value > 0 ? '+' : '') + (share ? (100*value).toFixed(1)+(delta?' pp':'%') : Number.isInteger(value)?String(value):value.toFixed(2));
    /** Bind displayed figures to exact API numbers for the native Dashboard journey. */
    const line = (label, key, share = false, group = null) => {
      const a = group ? current[group][key] : current[key], b = group ? previous[group][key] : previous[key], d = group ? change[group][key] : change[key];
      return '<tr data-stats-comparison="'+esc(group ? group+'.'+key : key)+'" data-current="'+esc(JSON.stringify(a))+'" data-previous="'+esc(JSON.stringify(b))+'" data-change="'+esc(JSON.stringify(d))+'"><th scope="row">'+esc(label)+'</th><td>'+esc(figure(a,share))+'</td><td>'+esc(figure(b,share))+'</td><td>'+esc(figure(d,share,true))+'</td></tr>';
    };
    const totals = [['Landed','landed'],['Agent-hours','agentHours'],['Agent-hours / landing','agentHoursPerLanding'],['Idle share','idleShare',true],['Submits / item','submitsPerItem'],['Reject rate','rejectRate',true],['Coordinator shouts / landing','shoutsPerLanding']].map(row=>line(...row)).join('');
    const idle = [['Nothing eligible','nothing-eligible'],['Held','held'],['Waiting for review family','review-family'],['Main red','main-red'],['Unknown','unknown']].map(([label,key])=>line('Idle: '+label,key,true,'idleReasons')).join('');
    const stages = [['Build','build'],['Rework','rework'],['Review wait','reviewWait'],['Review','review'],['Land','land']].map(([label,key])=>line('Stage: '+label,key,true,'stageShares')).join('');
    /** Minute precision and the caller's zone keep both ranges on the person's clock. */
    const stamp = value => new Date(value).toLocaleTimeString(locale, { timeZone, hour: 'numeric', minute: '2-digit' });
    const caption = '<span class="window-range" data-stats-as-of="'+esc(current.until)+'" title="'+esc(observed.durationMinutes)+'-minute windows">'+esc(stamp(current.since)+'–'+stamp(current.until)+' against '+stamp(previous.since)+'–'+stamp(previous.until))+'</span>';
    const metrics = [['Landed','landed',false,true], ['Sent back','rejectRate',true,false], ['Agents idle','idleShare',true,false], ['Agent-hours per landing','agentHoursPerLanding',false,false]];
    /** A missing canonical value never becomes a zero or a direction of improvement. */
    const measured = value => typeof value === 'number' && Number.isFinite(value);
    /** Compact headline values retain percentage-point units for share changes. */
    const compact = (value, share, key) => !measured(value) ? 'unmeasured' : share ? (100*value).toFixed(1)+'%' : key === 'landed' ? String(value) : value.toFixed(1);
    /** Color reflects this measure's direction, rather than treating every increase as good. */
    const direction = (delta, higherBetter) => !measured(delta) || delta === 0 ? '' : (delta > 0) === higherBetter ? 'good' : 'bad';
    const tiles = metrics.map(([label,key,share,higherBetter]) => {
      const a = current[key], b = previous[key], delta = change[key], tone = direction(delta,higherBetter);
      const max = share ? 1 : Math.max(measured(a)?a:0,measured(b)?b:0,1);
      const difference = !measured(delta) ? 'unmeasured' : delta === 0 ? 'No change' : (delta > 0 ? '▲ ' : '▼ ') + (share ? (Math.abs(delta)*100).toFixed(1)+' pts' : key==='landed' ? String(Math.abs(delta)) : Math.abs(delta).toFixed(1));
      return '<div class="window-tile '+tone+'" data-window-tile="'+key+'"><div class="window-key">'+label+'</div><div class="window-value"><b>'+esc(compact(a,share,key))+'</b><span class="window-change '+tone+'">'+esc(difference)+'</span></div><svg class="window-bar" viewBox="0 0 1000 6" preserveAspectRatio="none" aria-hidden="true">'+(measured(b)?'<rect class="window-before" x="0" y="0" height="6" width="'+Math.min(1000,Math.max(0,b/max*1000))+'"/>':'')+(measured(a)?'<rect class="window-after" x="0" y="0" height="6" width="'+Math.min(1000,Math.max(0,a/max*1000))+'"/>':'')+'</svg><small>was '+esc(compact(b,share,key))+'</small></div>';
    }).join('');
    /** Generate plain changes from all four observed values without inventing a causal explanation. */
    const sentence = metrics.map(([label,key,share]) => {
      const a=current[key], b=previous[key], d=change[key];
      if (!measured(a) || !measured(b) || !measured(d)) return label+' is unmeasured for one or both windows.';
      return label+': '+compact(a,share,key)+(d===0?', unchanged.':', '+(d>0?'up':'down')+' from '+compact(b,share,key)+'.');
    }).join(' ');
    const stageKeys = [['Build','build'],['Rework','rework'],['Waiting for review','reviewWait'],['Review','review'],['Landing','land']];
    /** Shares already come normalized from the canonical API; no browser lifecycle replay is used. */
    const stack = (period, label) => {
      const shares = observed[period].stageShares;
      let offset = 0;
      const bars = stageKeys.map(([name,key]) => {
        if (!measured(shares[key])) return '';
        const x = offset; offset += Math.max(0,shares[key]);
        return '<rect class="window-stage-'+key+'" data-window-stage="'+period+'.'+key+'" data-share="'+shares[key]+'" x="'+x*1000+'" y="0" height="1" width="'+Math.max(0,shares[key])*1000+'"><title>'+name+' '+(shares[key]*100).toFixed(1)+'%</title></rect>';
      }).join('');
      return '<div class="window-stage-row"><span>'+label+'</span><svg class="window-stack" viewBox="0 0 1000 1" preserveAspectRatio="none" role="img" aria-label="'+label+' item time">'+bars+'</svg></div>';
    };
    const legend = '<div class="window-keys">'+stageKeys.map(([label,key]) => '<span><i class="window-stage-'+key+'"></i>'+label+' '+esc(compact(current.stageShares[key],true,key))+'</span>').join('')+'</div>';
    return '<section class="dash-card window-comparison" aria-label="Window comparison"><div class="window-head"><h2>The last two hours</h2>'+caption+'</div><p class="window-sentence">'+esc(sentence)+'</p><div class="window-tiles">'+tiles+'</div><h3 class="window-time-heading">Where item time went</h3>'+stack('current','now')+stack('previous','before')+legend
      + '<details class="dash-comparison" data-dashboard-disclosure="comparison"><summary>All 17 measures →</summary><table><thead><tr><th>Metric</th><th>Current</th><th>Previous</th><th>Change</th></tr></thead><tbody>'+totals+idle+stages+'</tbody></table><p>Idle reasons use all observed seat-hours as their denominator and add up to the idle share; older reasons remain unknown. Stage shares use the five recorded stage durations. Rework is time returned to open. Share changes are percentage points.</p></details></section>';
  };
  return hero+needsCard+stageStrip+comparison()+shipping+'<div class="dash-two">'+card('Landed per hour',m.complete?bars:'<p>Loading complete landing history…</p>')+card('Agent time',m.complete?split:'<p>Loading complete agent history…</p>')+'</div>'+agents+landing+'<div class="dash-three">'+listCard('Just landed',m.landed.map(row=>({entry:row.item,at:row.at})),'All landed in Activity','data-tab="activity"')+listCard('In review',m.inReview.map(entry=>({entry,at:m.last(entry,'submit')})),'All in review, oldest first','data-dashboard-list="review"')+listCard('Next up',m.next.map(entry=>({entry,at:Date.parse(entry.updatedAt)||m.now})),'All ready, in rank order','data-dashboard-list="next"')+'</div><div class="dash-two dash-reference">'+rulesCard+capacityCard+'</div>';
}
