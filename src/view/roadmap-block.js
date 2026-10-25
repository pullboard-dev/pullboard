/** Compact Roadmap detail, using the same item read and local display words as Items [N26]. */
export function roadmapBlock(item, context = {}) {
  if (!item) return null;
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const items = context.items || [], boardAgents = context.agents || [];
  // An agent's name: its display name with the model, or its name alone when the model is unknown (the display name would carry an "unknown" placeholder).
  const name = context.name || (id => { const agent = boardAgents.find(entry => entry.agent_id === id), model = agent?.model || agent?.agent_model; return !model || model === 'unknown' ? id : agent.displayName || id + ' (' + model + ')'; });
  // A time as the viewer's locale writes it with hours and minutes (7:09 PM in English), with the date first when it is not today.
  const time = context.time || (iso => { const moment = new Date(iso), clock = moment.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); return moment.toDateString() === new Date().toDateString() ? clock : moment.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + clock; });
  const waits = (item.blockedBy || []).map(id => items.find(other => other.id === id) || {id,status:'unavailable'});
  const hold = (context.holds || []).find(h => h.hold_lane === item.lane);
  // The item's own hold, held apart from its lane's (#1256).
  const own = (Array.isArray(context.itemHolds) ? context.itemHolds : []).find(h => h.item === item.id);
  const blocked = item.status === 'open' && Boolean(waits.length || hold || own);
  const label = blocked ? 'Blocked: ' + [waits.length ? 'waits on ' + waits.map(w => '#' + w.id + ' (' + w.status + ')').join(', ') : '',own ? 'held: ' + own.reason : '',hold ? 'lane ' + item.lane + ' held' : ''].filter(Boolean).join('; ') : '';
  const paths = {
    Criterion:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 9v6m-3-3h6"/>',
    Agents:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-17a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3"/>',
    'Waits on':'<path d="M6 3h12M6 21h12M7 3v4l10 10v4M17 3v4L7 17v4"/>',
    Blocks:'<path d="M5 4v8a5 5 0 0 0 5 5h9m-5-5 5 5-5 5"/>',
    'Sent back':'<path d="m9 4-5 5 5 5M4 9h10a6 6 0 0 1 0 12h-3"/>',
    History:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
    Release:'<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7" cy="7" r="1"/>',
  };
  const icon = field => '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + paths[field] + '</svg>';
  const state = other => context.state ? context.state(other) : other.status === 'claimed' ? 'building' : other.status === 'submitted' ? 'verify' : other.status === 'verified' ? 'verified' : other.verdict?.decision === 'REJECT' ? 'back' : 'open';
  const words = {building:['building','busy'],verify:['to verify','warn'],verified:[null,'ok'],back:['sent back','no'],open:['unclaimed','free'],withdrawn:['withdrawn','']};
  const ref = other => {const [word,color] = words[state(other)] || [other.status,''];return '<span class="chip roadmap-ref '+color+'">#'+escape(other.id)+' '+escape(word || (other.merged || other.stage === 'merged' ? 'landed' : 'verified'))+'</span>';};
  const field = (key,value,extra='') => value ? '<dt>'+icon(key)+escape(key)+'</dt><dd'+(extra?' class="'+extra+'"':'')+'>'+value+'</dd>' : '';
  const first = text => String(text || '').split('\n').find(line => line.trim())?.trim() || '';
  /**
   * The first sentence of a send-back note, cut at 160 characters. An ellipsis marks any text left out,
   * so a reader knows the full note is one click away in Items (the row never shows it all).
   */
  const shortNote = text => {
    const line = first(text), sentence = line.match(/^.*?[.!?](?=\s|$)/u)?.[0] || line;
    const short = sentence.length > 160 ? sentence.slice(0, 160).trimEnd() : sentence;
    return short.length < text.length ? short + '…' : short;
  };
  const criterion = first(item.criterion).match(/^.*?[.!?](?:\s|$)|^.*$/u)?.[0]?.trim() || '';
  const agents = [];
  const builder = item.status === 'claimed' ? item.claim?.by || item.owner : item.builtBy;
  const reviewer = item.status === 'submitted' ? item.claim?.by || item.reviewer : item.verifiedBy;
  if (builder) agents.push('<b>'+escape(name(builder))+'</b> '+(item.status === 'claimed'?'building':'built'));
  if (reviewer) agents.push('<b>'+escape(name(reviewer))+'</b> '+(item.status === 'submitted'?'verifying':'verified'));
  const waiting = waits.map(other => {
    const holder = ['claimed','submitted'].includes(other.status) ? other.claim?.by || (other.status==='claimed'?other.owner:other.reviewer) : null;
    return ref(other)+(holder?' <b>'+escape(name(holder))+'</b>':'')+(other.since?' <span class="muted">since '+escape(time(other.since))+'</span>':'');
  });
  if (own) waiting.push('<span class="chip warn">held</span> '+escape(own.reason));
  if (hold) waiting.push('<span class="chip warn">lane held</span> '+escape(item.lane)+(hold.hold_reason?': '+escape(hold.hold_reason):''));
  const downstream = items.filter(other => other.status === 'open' && (other.blockedBy || []).includes(item.id));
  const reject = (item.verdicts || []).findLast(v => v.decision === 'REJECT') || (item.verdict?.decision === 'REJECT' ? item.verdict : null);
  const reasons = {TEST_FAILURE:'A test failed',BEHAVIOR_MISMATCH:'Behavior differs from the criterion',INSUFFICIENT_EVIDENCE:'More evidence is needed',STALE_HEAD:'The submitted commit is out of date',OTHER:'Sent back'};
  let returned = '';
  if (reject) {
    const note = shortNote(String(reject.note ?? '').trim().replace(new RegExp('^'+String(reject.reason || '')+'(?::|\\s*[-–—])?\\s*','u'),''));
    returned = (reject.at?escape(time(reject.at))+' ':'')+(reject.by?'by <b>'+escape(name(reject.by))+'</b>: ':'')+escape(note || reasons[reject.reason] || 'Sent back');
  }
  let claims = 0;
  const moves = {add:['added','free'],claim:['claimed','busy'],submit:['submitted','warn'],accept:['accepted','ok'],reject:['sent back','no'],merged:['landed','ok']};
  const history = (item.history || []).filter(event => moves[event.kind]).map(event => {
    let [word,color] = moves[event.kind];if(event.kind==='claim' && ++claims>1)word='claimed again';
    return '<span class="roadmap-event"><span class="roadmap-step '+color+'" aria-hidden="true"></span>'+escape(word)+' <time datetime="'+escape(event.at)+'">'+escape(time(event.at))+'</time></span>';
  }).join('<span class="roadmap-arrow" aria-hidden="true"> → </span>');
  const releases = (context.releases || []).map(release => '<b>'+escape(release)+'</b>').join(', ');
  const specs = (item.specs || []).map(escape).join(', ');
  const rows = field('Criterion',criterion?'<b>'+escape(criterion)+'</b>':'','roadmap-criterion')+field('Agents',agents.join(' · '))
    +field('Waits on',waiting.join('<br>'))+field('Blocks',downstream.map(ref).join(' '))
    +field('Sent back',returned,'roadmap-return')+field('History',history,'roadmap-history')
    +field('Release',[releases,specs?'spec '+specs:''].filter(Boolean).join(' · '));
  const address = context.address || (id => '#items/'+id);
  return {label,dot:blocked?'<span class="block-dot" role="img" aria-label="'+escape(label)+'" title="'+escape(label)+'"></span>':'',
    detail:context.loading?'<span class="roadmap-loading muted">Loading detail…</span>':context.error?'<p class="muted">'+escape(context.error)+'</p>':
      '<dl class="roadmap-detail">'+rows+'</dl><a class="ref roadmap-items" href="'+escape(address(item.id))+'" data-go="item:'+item.id+'"'+(context.board?' data-board="'+escape(context.board)+'"':'')+'>Open #'+item.id+' in Items <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/></svg></a>'};
}
