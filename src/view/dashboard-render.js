/** Render the approved Dashboard; all numbers come from its snapshot model, never mockup values [N26]. */
export function dashboardHtml(model, { needs = '', progress = '', deferQuiet, floorHref = null, locale = 'en-US', timeZone = 'UTC' } = {}) {
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
    };
    return '<svg class="dash-icon" data-dashboard-icon="'+name+'" aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+paths[name]+'</svg>';
  };
  /** Format actual elapsed minutes without a made-up lower bound. */
  const age = at => { const minutes = Math.max(0, Math.floor((m.now-at)/60_000)); return minutes < 60 ? minutes+'m' : (minutes/60).toFixed(1)+'h'; };
  /** A native item navigation target shares the existing cockpit dispatcher. */
  const item = entry => '<button class="dash-item" type="button" data-go="item:'+entry.id+'"><span>#'+entry.id+'</span><b>'+esc(entry.title)+'</b></button>';
  /** Keep section labels accessible even when the section has no work. */
  const card = (title, html, classes = '') => '<section class="dash-card '+classes+'" aria-label="'+esc(title)+'"><h2>'+esc(title)+'</h2>'+html+'</section>';
  /** Unknown history is explicitly loading/unavailable rather than a zero. */
  const count = value => value === null || value === undefined ? '—' : value.toLocaleString(locale);
  const six = m.pace ? m.pace.last6h/6 : null, two = m.pace ? m.pace.last2h/2 : null;
  const hero = '<section class="dash-card dash-hero"><div><h1>'+m.totals.working+(m.totals.working===1?' agent at work.':' agents at work.')+'</h1><p class="dash-accent">'+count(m.totals.day)+' landed in the last 24 hours.</p><div class="dash-chips"><span>'+icon('clock')+'Last 4 hours</span>'+[['recent','landed','land'],['passed','passed review','pass'],['sentBack','sent back to fix','back'],['shouts','shouts to you','msg']].map(([key,label,symbol])=>'<span>'+icon(symbol)+count(m.totals[key])+' '+label+'</span>').join('')+'</div></div><div class="dash-rate"><b data-dashboard-stat="pace6" data-value="'+esc(six)+'">'+(six===null?'—':six.toFixed(1))+'</b> items an hour<small>today’s pace, the last 6 hours</small><small>'+(two===null?'—':two.toFixed(1))+' /h last 2 h · '+count(m.totals.allTime)+' landed all time</small></div><span class="visually-hidden" data-dashboard-stat="building" data-value="'+m.claims.length+'">'+m.claims.length+' building</span></section>';
  const needsCard = card('Needs you', needs ? '<ol class="needs home-needs">'+needs+'</ol>' : '<p><b>Nothing needs you.</b> When a decision is yours, it shows up here and on your phone.</p>');
  /** Current holding actors and elapsed stays come from the same claims as the headline. */
  const flight = (label, entries, kind) => {
    /** Render a real in-flight row without changing its holding state. */
    const line = entry => '<li>'+item(entry)+'<small>'+esc(kind==='claim'?entry.owner:entry.reviewer||'waiting for a reviewer')+(kind==='claim'||entry.reviewer?' · '+age(m.last(entry,kind)):'')+'</small></li>';
    return '<div class="dash-flight"><h3>'+label+' '+entries.length+'</h3><ul>'+entries.slice(0,4).map(line).join('')+'</ul>'+(entries.length>4?'<details data-dashboard-disclosure="'+kind+'"><summary>Show '+(entries.length-4)+' more</summary><ul>'+entries.slice(4).map(line).join('')+'</ul></details>':'')+'</div>';
  };
  /** Render shared Roadmap bounds as both hours and actual local weekday/time. */
  const finish = summary => {
    if (!summary?.estimate) return summary?.reason==='few-landings'?'Too few landings yet to estimate':'No estimate yet';
    const {low,high}=summary.estimate;
    /** Format each bound against the same observed clock. */
    const when = hours => new Date(m.now+hours*3_600_000).toLocaleString(locale, {timeZone,weekday:'long',hour:'numeric',minute:'2-digit'});
    return esc(low+(low===high?'':'–'+high)+' h')+'<small>'+esc(when(low))+(low===high?'':' – '+esc(when(high)))+'</small>';
  };
  const shipping = card('Shipping now', m.milestone ? '<div class="dash-release"><h3>'+esc(m.milestone.name)+'</h3><b>'+m.milestone.summary.left+' to go</b></div><p>'+m.milestone.summary.landed+' of '+m.milestone.summary.total+' landed</p>'+progress+'<h3>In flight</h3><div class="dash-two">'+flight('Building',m.inFlight.building,'claim')+flight('In review',m.inFlight.review,'submit')+'</div><div class="dash-three dash-stats"><div>Today’s pace<b>'+(six===null?'—':six.toFixed(1))+' <small>items an hour</small></b><small>'+count(m.pace?.last6h)+' landed in the last 6 h</small></div><div>Right now<b>'+(two===null?'—':two.toFixed(1))+' <small>items an hour</small></b><small>'+count(m.pace?.last2h)+' landed in the last 2 h</small></div><div>Done at this pace<b>'+finish(m.milestone.summary)+'</b></div></div>' : '<p>No release is in progress.</p>');
  const maximum = Math.max(1,...m.bins.map(bin=>bin.count),six??0), chartHeight = 100;
  const hourLabel = at => new Date(at).toLocaleTimeString(locale, { timeZone, hour: 'numeric' });
  const paceY = chartHeight-(six??0)/maximum*90;
  const bars = '<div class="dash-chart">'+(six===null?'':'<span class="dash-pace-tag">'+six.toFixed(1)+'/h today</span>')+'<svg viewBox="0 0 960 120" preserveAspectRatio="none" role="img" aria-label="Items landed per hour, last 24 hours">'+m.bins.map((bin,index)=>'<rect tabindex="0" x="'+(index*40+4)+'" y="'+(chartHeight-bin.count/maximum*90)+'" width="30" height="'+Math.max(1,bin.count/maximum*90)+'" rx="2"><title>'+esc(new Date(bin.from).toLocaleString(locale, { timeZone }))+' – '+esc(new Date(bin.to).toLocaleTimeString(locale, { timeZone }))+': '+bin.count+' landed</title></rect>').join('')+(six===null?'':'<line class="dash-pace-line" x1="720" x2="960" y1="'+paceY+'" y2="'+paceY+'"><title>'+six.toFixed(1)+' items an hour over the last 6 hours</title></line>')+'</svg>'+'</div><div class="dash-axis">'+[0,6,12,18,24].map(h=>'<span>'+esc(h===24?'now':hourLabel(m.now-(24-h)*3_600_000))+'</span>').join('')+'</div><p class="dash-chart-caption">'+count(m.totals.day)+' in 24 h · busiest hour '+Math.max(0,...m.bins.map(bin=>bin.count))+'</p>';
  const activeAgents = m.agents.filter(agent=>agent.last>m.start||agent.current.length);
  const totals = ['build','review','idle'].map(key=>activeAgents.reduce((sum,agent)=>sum+agent[key],0)), total = totals.reduce((sum,value)=>sum+value,0);
  const split = '<svg class="dash-split" viewBox="0 0 '+(total||1)+' 1" preserveAspectRatio="none" aria-label="Agent time split">'+totals.map((value,index)=>'<rect class="dash-time-'+index+'" x="'+totals.slice(0,index).reduce((sum,v)=>sum+v,0)+'" y="0" width="'+value+'" height="1"/>').join('')+'</svg>'+['Building','Reviewing','Between items'].map((label,index)=>'<p class="dash-time-key"><span>'+label+'</span><b>'+(total?Math.round(totals[index]/total*100):0)+'%</b><span>'+(totals[index]/3_600_000).toFixed(1)+' h</span></p>').join('');
  /** Each SVG interval has a real event-derived item and duration tooltip. */
  const agentRow = agent => '<div class="dash-agent" data-dashboard-agent="'+esc(agent.id)+'"><b title="'+esc(agent.model?agent.id+' · '+agent.model:agent.id)+'">'+icon(agent.group==='building'?'build':agent.group==='reviewing'?'review':'dots')+esc(agent.name)+'</b><svg viewBox="0 0 400 20" preserveAspectRatio="none" aria-label="'+esc(agent.id)+' last four hours"><path class="dash-track" d="M0 10H400"/>'+[1,2,3].map(index=>'<path class="dash-tick" d="M'+index*100+' 3V17"/>').join('')+agent.segments.map(segment=>'<rect class="'+segment.kind+'" x="'+((segment.start-m.start)/14_400_000*400)+'" y="4" height="12" width="'+Math.max(1,(segment.end-segment.start)/14_400_000*400)+'" rx="2"><title>#'+segment.item+' '+esc(segment.kind==='build'?'building':'reviewing')+' · '+((segment.end-segment.start)/60_000).toFixed(0)+'m</title></rect>').join('')+(agent.sentBack??[]).map(event=>'<rect class="dash-sent-back" x="'+((event.at-m.start)/14_400_000*400)+'" y="1" height="18" width="3"><title>#'+event.item+' sent back</title></rect>').join('')+'</svg><span class="dash-agent-now">'+(agent.current.length?agent.current.map(held=>item(held.item)).join(''):'between items')+'</span><span class="dash-agent-number">'+(agent.build/3_600_000).toFixed(1)+'h</span><span class="dash-agent-number">'+(agent.review/3_600_000).toFixed(1)+'h</span><span class="dash-agent-number">'+agent.shouts+'</span></div>';
  const groups = ['building','reviewing','between items'];
  const quiet = m.agents.filter(agent=>agent.group==='quiet');
  /** Defer only a closed disclosure's real rows; its current-model closure retains every field. */
  const quietRows = () => quiet.map(agentRow).join('');
  if (quiet.length && deferQuiet) deferQuiet(quietRows);
  const legend = '<div class="dash-agent-legend">'+[['build','building'],['review','reviewing'],['back','sent back']].map(([symbol,label])=>'<span>'+icon(symbol)+label+'</span>').join('')+'</div>';
  const agents = card('Agents',legend+'<div class="dash-agent-axis"><span>Agent</span><span>'+[4,3,2,1,0].map(h=>'<span>'+esc(h?hourLabel(m.now-h*3_600_000):'now')+'</span>').join('')+'</span><span>Now</span><span>Build</span><span>Review</span><span>Shouts</span></div>'+groups.map(group=>{const rows=m.agents.filter(agent=>agent.group===group);return rows.length?'<h3 class="dash-agent-group">'+esc(group.toUpperCase())+' · '+rows.length+'</h3>'+rows.map(agentRow).join(''):'';}).join('')+(quiet.length?'<details data-dashboard-disclosure="quiet"><summary>'+quiet.length+' quiet agents · nothing in the last 20 minutes</summary>'+'<div data-dashboard-quiet-rows>'+ (deferQuiet ? '' : quietRows())+'</div></details>':'')+(!m.complete?'<p class="muted">Complete history is loading; historical totals are not yet available.</p>':'')+(floorHref?'<a class="link dash-floor-link" href="'+esc(floorHref)+'" data-tab="dashboard" data-detail="floor">Open the agent floor →</a>':''));
  const landing = card('Landing now', m.landing.length?'<ul class="dash-list">'+m.landing.map(entry=>'<li>'+item(entry)+'<small>'+esc(entry.builtBy||'unknown builder')+' · '+esc(entry.verifiedBy||'unknown reviewer')+' · passed '+age(m.last(entry,'accept'))+' ago</small></li>').join('')+'</ul>':'<p>No accepted items are waiting to land.</p>');
  /** Complete list links reuse the established item filters and Activity tab. */
  const listCard = (title, entries, footer, target) => card(title,'<ul class="dash-list">'+entries.slice(0,8).map(({entry,at})=>'<li>'+item(entry)+'<small'+(title==='In review'&&m.now-at>3_600_000?' class="dash-old"':'')+'>'+age(at)+'</small></li>').join('')+'</ul><button type="button" class="link" '+target+'>'+esc(footer)+' →</button>');
  return hero+needsCard+shipping+'<div class="dash-two">'+card('Landed per hour',m.complete?bars:'<p>Loading complete landing history…</p>')+card('Agent time',m.complete?split:'<p>Loading complete agent history…</p>')+'</div>'+agents+landing+'<div class="dash-three">'+listCard('Just landed',m.landed.map(row=>({entry:row.item,at:row.at})),'All landed in Activity','data-tab="activity"')+listCard('In review',m.inReview.map(entry=>({entry,at:m.last(entry,'submit')})),'All in review, oldest first','data-dashboard-list="review"')+listCard('Next up',m.next.map(entry=>({entry,at:Date.parse(entry.updatedAt)||m.now})),'All ready, in rank order','data-dashboard-list="next"')+'</div>';
}
