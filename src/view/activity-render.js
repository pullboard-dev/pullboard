/** The approved Activity sentences, rendered once for live and exported views [N26].
 * Standalone because the page embeds this function's source text.
 */
export function activityHtml(model, { filter = 'all', words, itemHref = id => '#item/' + id, open = [], dayLabel = value => new Date(value).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }), quote = null } = {}) {
  const esc = value => String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const clock = value => new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const localTimes = text => String(text ?? '').replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b/gu,
    value => Number.isFinite(Date.parse(value)) ? clock(value) : value);
  const who = (id, agent) => '<span class="activity-who"' + (agent?.model || agent?.agent_model ? ' title="' + esc(agent.model || agent.agent_model) + '"' : '') + '>' + esc(id === 'coordinator' ? 'The coordinator' : id === 'person' ? 'The person' : id) + '</span>';
  const item = entry => '<span class="activity-item" title="' + esc(entry.title) + '"><a class="ref" href="' + esc(itemHref(entry.id)) + '" data-go="item:' + entry.id + '">#' + entry.id + '</a>' + esc(entry.title) + '</span>';
  const paths = {
    build: '<path d="m9.5 2.5 4 4-1.5 1.5-4-4zM8 4 2.5 9.5l4 4L12 8"/>',
    release: '<path d="M4 8h8M9 5l3 3-3 3"/>', back: '<path d="m6 4-3.5 3.5L6 11M2.5 7.5H10a3.5 3.5 0 0 1 0 7H8"/>',
    note: '<path d="M4 4h8M4 8h8M4 12h5"/>', proof: '<path d="M6 2.5h4M7 2.5v4L3.5 12.5a1 1 0 0 0 .9 1.5h7.2a1 1 0 0 0 .9-1.5L9 6.5v-4"/>',
    shout: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
    sentinel: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
    pass: '<path d="m3 8 3.5 3.5L13 5"/>',
  };
  const icon = kind => '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + paths[kind] + '</svg>';
  const pill = (n, label, tone) => n ? '<span class="activity-pill ' + tone + '">' + n + ' ' + label + '</span>' : '';
  const row = entry => {
    let tone = 'note', glyph = 'note', content;
    if (entry.kind === 'sentinels') {
      tone = 'sentinel'; glyph = 'sentinel';
      const line = (finding, still = false) => {
        const text = words(finding, { now: Date.parse(entry.at), clock });
        return '<li class="' + (finding.resolved ? 'resolved' : still ? 'stuck' : 'failing') + '"><i aria-hidden="true"></i><span>'
          + esc(text.text) + (finding.resolved ? ' · resolved' : '') + (text.since ? ', since ' + esc(text.since) : '')
          + (text.next && !finding.resolved ? ' <span class="activity-next">· Next: ' + esc(text.next) + '</span>' : '') + '</span></li>';
      };
      content = '<details class="activity-run" data-activity-run="' + esc(entry.id) + '"' + (open.includes(entry.id) ? ' open' : '') + '><summary><span><b>Sentinels</b> checked the board</span>'
        + pill(entry.failing, 'failing', 'failing') + pill(entry.resolved, 'resolved', 'resolved') + pill(entry.stuck, 'stuck', 'stuck') + pill(entry.heldBack, 'more held back', 'quiet')
        + '<svg class="activity-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg></summary><ul class="activity-lines">'
        + entry.findings.map(finding => line(finding)).join('') + entry.stillStuck.map(finding => line(finding, true)).join('') + '</ul></details>';
    } else {
      if (entry.kind === 'shout') { tone = 'shout'; glyph = 'shout'; }
      else if (['claim', 'merged', 'accept', 'release'].includes(entry.kind)) { tone = 'build'; glyph = entry.kind === 'release' ? 'release' : entry.kind === 'accept' || entry.kind === 'merged' ? 'pass' : 'build'; }
      else if (['reserve', 'proof-run', 'submit'].includes(entry.kind)) { tone = 'review'; glyph = 'proof'; }
      else if (['reject', 'reopen'].includes(entry.kind)) { tone = 'back'; glyph = 'back'; }
      const sentence = entry.released ? 'let go of <b>#' + entry.released.id + '</b> and started building <b>#' + entry.item.id + '</b>' : esc(entry.verb);
      content = '<p>' + who(entry.by, entry.agent) + ' ' + sentence + (entry.kind === 'shout' ? ' ' + esc(entry.to === 'coordinator' ? 'the coordinator' : entry.to === 'person' ? 'the person' : entry.to || 'the board') : '') + '</p>'
        + (entry.item ? item(entry.item) : '') + (entry.kind === 'shout' && entry.words ? '<blockquote class="activity-quote">' + (quote ? quote(localTimes(entry.words)) : esc(localTimes(entry.words))) + '</blockquote>' : '');
    }
    return '<li class="activity-event" data-activity-kind="' + esc(entry.kind) + '"><time>' + esc(clock(entry.at)) + '</time><span class="activity-verb ' + tone + '">' + icon(glyph) + '</span><div class="activity-say">' + content + '</div></li>';
  };
  const filters = '<div class="activity-bar"><div class="seg" role="group" aria-label="Activity filter">' + [['all', 'All'], ['work', 'Work'], ['sentinels', 'Sentinels'], ['shouts', 'Shouts']].map(([key, label]) =>
    '<button type="button" data-activity-filter="' + key + '" aria-pressed="' + (filter === key) + '" class="' + (filter === key ? 'on' : '') + '">' + label + '<b>' + model.counts[key] + '</b></button>').join('') + '</div></div>';
  const rows = model.rows.filter(entry => filter === 'all' || entry.category === filter);
  let day = '';
  const days = rows.map(entry => {
    const key = new Date(entry.at).toDateString();
    const heading = key === day ? '' : '<li class="activity-day"><h4 class="day">' + esc(dayLabel(entry.at)) + '</h4></li>';
    day = key; return heading + row(entry);
  }).join('');
  return filters + (rows.length ? '<ol class="activity-events">' + days + '</ol>' : '<p class="empty">No activity matches.</p>');
}
