/** The approved release header shared by Dashboard and Roadmap, using only backend summary counts [N26]. */
export function roadmapSummary(milestone, context = {}) {
  /** Escape supplied milestone text before placing it in HTML or attributes. */
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const summary = milestone.summary;
  const states = [['landed','landed'],['landing','accepted, landing'],['review','in review'],['building','building'],['waiting','waiting'],['held','held']];
  /** Accept only nonnegative integer counts from the backend contract. */
  const number = value => Number.isInteger(value) && value >= 0;
  if (!summary || !number(summary.total) || !number(summary.left) || states.some(([key]) => !number(summary[key]))) return null;
  // Only a milestone with work left has a header: a finished one or an empty plan never reads "0 remaining" or
  // "About 0 hours"; an empty plan keeps its No items yet reading, as before this header.
  if (summary.left === 0) return null;
  const count = '<span class="roadmap-left"><b>'+escape(summary.left)+' to go</b><span aria-label="'+escape(summary.landed)+'/'+escape(summary.total)+' landed">'+escape(summary.landed)+' of '+escape(summary.total)+' landed</span></span>';
  const description = states.map(([key,label]) => summary[key]+' '+label).join(', ');
  let offset = 0;
  const segments = states.map(([key]) => { const x = offset; offset += summary[key]; return '<rect class="roadmap-summary-segment ' + key + '" data-summary-segment="' + key + '" data-count="' + summary[key] + '" x="' + x + '" width="' + summary[key] + '" height="1"' + (key === 'landing' ? ' fill="url(#roadmap-summary-stripe)"' : '') + '/>'; }).join('');
  // Landing is striped: an SVG rect paints from its fill, so the stripe is a pattern the rect references, not a CSS background.
  const stripe = '<defs><pattern id="roadmap-summary-stripe" patternUnits="userSpaceOnUse" width="' + ((summary.total || 1) / 60) + '" height="1" patternTransform="skewX(-' + Math.round(Math.atan((summary.total || 1) / 30) * 180 / Math.PI) + ')"><rect class="roadmap-stripe-a" width="' + ((summary.total || 1) / 120) + '" height="1"/><rect class="roadmap-stripe-b" x="' + ((summary.total || 1) / 120) + '" width="' + ((summary.total || 1) / 120) + '" height="1"/></pattern></defs>';
  // Geometry uses the supplied counts as SVG units; inline CSS is disallowed by the view's policy.
  const bar = '<svg class="milestone-progress roadmap-summary-bar" viewBox="0 0 ' + (summary.total || 1) + ' 1" preserveAspectRatio="none" role="img" aria-label="' + escape(milestone.name+': '+description) + '" data-total="' + summary.total + '">' + stripe + segments + '</svg>';
  // The held count opens the held items alone, and a second press shows every item again (#1256).
  const heldLink = key => key === 'held' && summary.held > 0;
  /** Keep every legend entry's dot, count and label in the same aligned structure. */
  const legendEntry = ([key, label]) => (heldLink(key)
    ? '<button type="button" class="link roadmap-held-link" data-roadmap-held="'+escape(milestone.name)+'" aria-pressed="'+(context.held === milestone.name)+'" data-summary-state="'+key+'">'
    : '<span data-summary-state="'+key+'">')+'<i class="roadmap-summary-swatch '+key+'" aria-hidden="true"></i><b>'+escape(summary[key])+'</b> <span>'+label+'</span>'+(heldLink(key) ? '</button>' : '</span>');
  const legend = '<div class="roadmap-summary-legend">'+states.map(legendEntry).join('')+'</div>';
  const target = milestone.target ? '<span class="roadmap-target">Target <time datetime="'+escape(milestone.target)+'">'+escape(context.targetLabel !== undefined ? context.targetLabel : milestone.target)+'</time>'+(milestone.pastTarget?' <span class="chip warn">past target</span>':'')+'</span>' : '';
  const estimate = summary.estimate, pace = summary.pace;
  // Convert a backend remaining-time range into the one-person estimate shared by both release surfaces.
  /** Read a weekday and part of day at the browser's explicit locale and time zone. */
  const completionTime = () => {
    if (!estimate || !Number.isFinite(estimate.low) || !Number.isFinite(estimate.high)) return '';
    if (!Number.isFinite(context.now)) return '';
    const now = context.now;
    const hours = Math.max(0, Math.round((estimate.low + estimate.high) / 2));
    const completionAt = now + hours * 3_600_000;
    if (!Number.isFinite(completionAt) || Math.abs(completionAt) > 8.64e15) return '';
    const locale = context.locale || 'en-US', timeZone = context.timeZone || 'UTC';
    const parts = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'long', hour: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date(completionAt));
    const weekday = parts.find(part => part.type === 'weekday')?.value || '';
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const part = hour < 5 ? 'overnight' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
    const days = hours >= 24, amount = days ? Math.max(1, Math.round(hours / 24)) : Math.max(1, hours);
    const unit = days ? 'day' : 'hour';
    return 'done in about '+amount+' '+unit+(amount === 1 ? '' : 's')+', '+weekday+' '+part;
  };
  const completion = completionTime() || (summary.reason === 'few-landings' ? 'too few landings yet to estimate' : 'completion time unavailable');
  const paced = pace && number(pace.last6h) && number(pace.last2h);
  const rate = paced ? (pace.last6h / 6).toFixed(1) : '—';
  const forecast = '<p class="roadmap-forecast"><span class="roadmap-estimate">'+rate+' items an hour</span> · <span class="roadmap-pace">'+escape(paced ? pace.last6h : '—')+' landed in the last 6 h, '+escape(paced ? pace.last2h : '—')+' in the last 2 h</span> · <span class="roadmap-completion">'+escape(completion)+'</span></p>';
  const meta = target ? '<div class="roadmap-summary-meta">'+target+'</div>' : '';
  const needs = Array.isArray(summary.needsYou) ? summary.needsYou.map(id => {
    const item = context.needs?.get(id);
    const text = escape(item?.label || '#'+id)+(item?.title?' '+escape(item.title):'');
    return item?.address ? '<a class="ref" href="'+escape(item.address)+'" data-go="item:'+escape(item.id)+'"'+(item.board?' data-board="'+escape(item.board)+'"':'')+'>'+text+'</a>' : '<span>'+text+'</span>';
  }).join(', ') : '';
  const top = '<div class="release-header-top"><h2 class="release-name" data-release-name="">'+(typeof context.nameHtml === 'string' ? context.nameHtml : escape(milestone.name))+'</h2>'+count+forecast+'</div>';
  const detail = '<div class="roadmap-summary"><div class="roadmap-summary-row"><div class="roadmap-summary-track">'+bar+'</div>'+legend+'</div>'+meta+(needs?'<div class="roadmap-summary-needs"><b>Needs you:</b> '+needs+'</div>':'')+'</div>';
  return { count, top, detail, header: '<div class="release-header">'+top+detail+'</div>' };
}

/**
 * The header for each milestone read, made once and reused across its header, body and companion panel [N26]. Why here:
 * the page embeds this source, so it keeps apps/cli/src/io/cockpit.js inside its line cap; the page hands in what it reads by.
 *
 * @param {{targetLabels: Map, addresses: Map, headings?: Map, root: string, held?: string|null}} page - Prepared display observations.
 * @returns {(read: {milestone: object, rows: object[]}|null) => object|null}
 */
export function roadmapHeaders(page) {
  const made = new Map();
  return (read) => {
    if (!read) return null;
    if (!made.has(read)) {
      const needs = new Map((Array.isArray(read.milestone.summary?.needsYou) ? read.milestone.summary.needsYou : []).map(id => {
        const label = typeof id === 'number' ? '#' + id : String(id), row = read.rows.find(row => row.label === label);
        return [id, row ? { label, title: row.title, id: row.open?.id, address: row.open ? page.addresses.get(row) : null,
          board: row.open?.root !== page.root ? row.open?.root : null } : null];
      }));
      made.set(read, roadmapSummary(read.milestone, { targetLabel: page.targetLabels.get(read), nameHtml: page.headings?.get(read), held: page.held, needs,
        now: page.now, locale: page.locale, timeZone: page.timeZone }));
    }
    return made.get(read);
  };
}
