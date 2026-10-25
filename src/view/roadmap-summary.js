/** The approved Roadmap header, displaying the backend's summary without deriving board counts [N26]. */
export function roadmapSummary(milestone, context = {}) {
  /** Escape supplied milestone text before placing it in HTML or attributes. */
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const summary = milestone.summary;
  const states = [['landed','landed'],['landing','accepted, landing'],['review','in review'],['building','building'],['waiting','waiting'],['held','held']];
  /** Accept only nonnegative integer counts from the backend contract. */
  const number = value => Number.isInteger(value) && value >= 0;
  if (!summary || !number(summary.total) || !number(summary.left) || states.some(([key]) => !number(summary[key]))) return null;
  // Only a milestone with work left has a header: a finished one or an empty plan never reads "0 remaining" or
  // "About 0 to 0 h"; an empty plan keeps its No items yet reading, as before this header.
  if (summary.left === 0) return null;
  const count = '<span class="roadmap-left"><b>'+escape(summary.left)+' remaining</b><span aria-label="'+escape(summary.landed)+'/'+escape(summary.total)+' landed">'+escape(summary.landed)+' of '+escape(summary.total)+' landed</span></span>';
  const description = states.map(([key,label]) => summary[key]+' '+label).join(', ');
  let offset = 0;
  const segments = states.map(([key]) => { const x = offset; offset += summary[key]; return '<rect class="roadmap-summary-segment ' + key + '" data-summary-segment="' + key + '" data-count="' + summary[key] + '" x="' + x + '" width="' + summary[key] + '" height="1"/>'; }).join('');
  // Geometry uses the supplied counts as SVG units; inline CSS is disallowed by the view's policy.
  const bar = '<svg class="milestone-progress roadmap-summary-bar" viewBox="0 0 ' + (summary.total || 1) + ' 1" preserveAspectRatio="none" role="img" aria-label="' + escape(milestone.name+': '+description) + '" data-total="' + summary.total + '">' + segments + '</svg>';
  // The held count opens the held items alone, and a second press shows every item again (#1256).
  const heldLink = key => key === 'held' && summary.held > 0;
  const legend = '<div class="roadmap-summary-legend">'+states.map(([key,label]) => (heldLink(key) ? '<button type="button" class="link roadmap-held-link" data-roadmap-held="'+escape(milestone.name)+'" aria-pressed="'+(context.held === milestone.name)+'" data-summary-state="'+key+'">' : '<span data-summary-state="'+key+'">')+'<i class="roadmap-summary-swatch '+key+'" aria-hidden="true"></i><b>'+escape(summary[key])+'</b> '+label+(heldLink(key) ? '</button>' : '</span>')).join('')+'</div>';
  const target = milestone.target ? '<span class="roadmap-target">Target <time datetime="'+escape(milestone.target)+'">'+escape(context.time ? context.time(milestone.target) : milestone.target)+'</time>'+(milestone.pastTarget?' <span class="chip warn">past target</span>':'')+'</span>' : '';
  const estimate = summary.estimate, pace = summary.pace;
  // The time line reads the summary's estimate, window and reason as given (#853): today's pace for the 6 h
  // window, the last day's for the 24 h window, and plain words when too few items have landed to estimate.
  const bounds = estimate && Number.isFinite(estimate.low) && Number.isFinite(estimate.high)
    ? escape(estimate.low)+(estimate.low === estimate.high ? '' : ' to '+escape(estimate.high))+' h' : '';
  const when = bounds ? 'About '+bounds+(summary.window === '24h' ? ' at the last day’s pace' : ' at today’s pace')
    : summary.reason === 'few-landings' ? 'Too few landings yet to estimate' : '';
  const paced = pace && number(pace.last6h) && number(pace.last2h);
  const forecast = when ? '<span class="roadmap-estimate">'+when+'</span>'+(paced ? '<span class="roadmap-pace">'+escape(pace.last6h)+' landed in the last 6 h, '+escape(pace.last2h)+' in the last 2 h</span>' : '') : '';
  const meta = target || forecast ? '<div class="roadmap-summary-meta">'+target+forecast+'</div>' : '';
  const needs = Array.isArray(summary.needsYou) ? summary.needsYou.map(id => {
    const item = context.lookup ? context.lookup(id) : null;
    const text = escape(item?.label || '#'+id)+(item?.title?' '+escape(item.title):'');
    return item?.address ? '<a class="ref" href="'+escape(item.address)+'" data-go="item:'+escape(item.id)+'"'+(item.board?' data-board="'+escape(item.board)+'"':'')+'>'+text+'</a>' : '<span>'+text+'</span>';
  }).join(', ') : '';
  return { count, detail: '<div class="roadmap-summary">'+bar+legend+meta+(needs?'<div class="roadmap-summary-needs"><b>Needs you:</b> '+needs+'</div>':'')+'</div>' };
}

/**
 * The header for each milestone read, made once and reused across its header, body and companion panel [N26]. Why here:
 * the page embeds this source, so it keeps src/cockpit.js inside its line cap; the page hands in what it reads by.
 *
 * @param {(milestone: object, context: object) => object|null} summarize - roadmapSummary.
 * @param {{time: (iso: string) => string, address: (id: number, root: string) => string, root: string, held?: string|null}} page
 * @returns {(read: {milestone: object, rows: object[]}|null) => object|null}
 */
export function roadmapHeaders(summarize, page) {
  const made = new Map();
  return (read) => {
    if (!read) return null;
    if (!made.has(read)) made.set(read, summarize(read.milestone, { time: page.time, held: page.held, lookup: (id) => {
      const label = typeof id === 'number' ? '#' + id : String(id), row = read.rows.find((row) => row.label === label);
      return row ? { label, title: row.title, id: row.open?.id, address: row.open ? page.address(row.open.id, row.open.root) : null, board: row.open?.root !== page.root ? row.open?.root : null } : null;
    } }));
    return made.get(read);
  };
}
