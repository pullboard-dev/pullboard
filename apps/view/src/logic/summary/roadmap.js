/** The approved release header shared by Dashboard and Roadmap, using only backend summary counts [N26]. */
export function roadmapSummary(milestone, context = {}) {
  /** Escape supplied milestone text before placing it in HTML or attributes. */
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const summary = milestone.summary;
  /** Accept only nonnegative integer counts from the backend contract. */
  const number = value => Number.isInteger(value) && value >= 0;
  // Ready is its own state when the board splits it out (the Dashboard's NOW calls the same items ready); then blocked counts only what waits on something (#7763).
  const states = [['landed','landed'],['landing','landing'],['review','in review'],['building','building'],...(number(summary?.ready) ? [['ready','ready']] : []),['waiting','blocked'],['held','held']];
  if (!summary || !number(summary.total) || !number(summary.left) || states.some(([key]) => !number(summary[key]))) return null;
  // Only a milestone with work left has a header: a finished one or an empty plan never reads "0 remaining" or
  // "About 0 hours"; an empty plan keeps its No items yet reading, as before this header.
  if (summary.left === 0) return null;
  /** Thousands separators, as the Dashboard's release card writes them. */
  const num = value => value.toLocaleString(context.locale || 'en-US');
  const count = '<span class="roadmap-left"><b>'+escape(num(summary.left))+' to go</b><span aria-label="'+escape(summary.landed)+'/'+escape(summary.total)+' landed">'+escape(num(summary.landed))+' of '+escape(num(summary.total))+' landed</span></span>';
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
    ? '<button type="button" class="link dash-key roadmap-held-link" data-roadmap-held="'+escape(milestone.name)+'" aria-pressed="'+(context.held === milestone.name)+'" data-summary-state="'+key+'">'
    : '<span class="dash-key" data-summary-state="'+key+'">')+'<i class="roadmap-summary-swatch '+key+'" aria-hidden="true"></i><b>'+escape(num(summary[key]))+'</b> <span>'+label+'</span>'+(heldLink(key) ? '</button>' : '</span>');
  const legend = '<div class="roadmap-summary-legend dash-keys">'+states.map(legendEntry).join('')+'</div>';
  const target = milestone.target ? '<span class="roadmap-target">Target <time datetime="'+escape(milestone.target)+'">'+escape(context.targetLabel !== undefined ? context.targetLabel : milestone.target)+'</time>'+(milestone.pastTarget?' <span class="chip warn">past target</span>':'')+'</span>' : '';
  const meta = target ? '<div class="roadmap-summary-meta">'+target+'</div>' : '';
  // A version leads in grey, then the name in bold, as on the Dashboard's release card.
  const named = /^(\d+(?:\.\d+)+(?:-[A-Za-z0-9]+)?)\s*:\s*(.+)$/u.exec(typeof context.nameHtml === 'string' ? context.nameHtml : escape(milestone.name));
  const title = named ? '<span class="dash-ver">'+named[1]+'</span>'+named[2] : (typeof context.nameHtml === 'string' ? context.nameHtml : escape(milestone.name));
  const top = '<div class="release-header-top"><h2 class="release-name" data-release-name="">'+title+'</h2>'+count+'</div>';
  const detail = '<div class="roadmap-summary"><div class="roadmap-summary-row"><div class="roadmap-summary-track">'+bar+'</div>'+legend+'</div>'+meta+'</div>';
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
      made.set(read, roadmapSummary(read.milestone, { targetLabel: page.targetLabels.get(read), nameHtml: page.headings?.get(read), held: page.held,
        now: page.now, locale: page.locale, timeZone: page.timeZone }));
    }
    return made.get(read);
  };
}
