import { sharedRowHtml } from "../component.js";
import { segmentedToggle } from "../segmented.js";
/** The approved Activity sentences, rendered once for live and exported views [N26].
 * Standalone because the page embeds this function's source text.
 */
export function activityHtml(model, { filter = 'all', open = [], controls = true } = {}) {
  const esc = value => String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  /** Missing model metadata is not a model name; retain real models only as hover titles. */
  const who = (id, agent) => {
    const model = [agent?.model, agent?.agent_model].find(value => typeof value === 'string' && value.trim() && value.trim().toLowerCase() !== 'unknown');
    return '<span class="activity-who"' + (model ? ' title="' + esc(model) + '"' : '') + '>' + esc(id === 'coordinator' ? 'The coordinator' : id === 'person' ? 'The person' : id) + '</span>';
  };
  const item = (entry, href) => '<span class="activity-item" title="' + esc(entry.title) + '"><a class="ref" href="' + esc(href) + '" data-go="item:' + entry.id + '">#' + entry.id + '</a>' + esc(entry.title) + '</span>';
  /** Keep a shout's item beside its sentence without repeating the work-row title below it. */
  const about = entry => entry.item ? ' <a class="activity-about ref" href="' + esc(entry.itemHref) + '" data-go="item:' + entry.item.id + '">about #' + entry.item.id + '</a>' : '';
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
  /** Show only recorded lifecycle evidence, leaving absent fields absent. */
  const evidence = entry => {
    const detail = entry.detail || {}, lines = [];
    if (typeof detail.note === 'string' && detail.note.trim()) lines.push(detail.note);
    if (entry.kind === 'submit' && detail.submissionProof) {
      const proof = detail.submissionProof;
      if (Array.isArray(proof.files) && proof.files.length) lines.push('Checks: ' + proof.files.join(', '));
      if (typeof proof.reason === 'string' && proof.reason.trim()) lines.push(proof.reason);
      if (typeof detail.gateGreen === 'boolean') lines.push(detail.gateGreen ? 'Check passed' : 'Check did not pass');
    }
    if (entry.kind === 'reject' && typeof detail.reason === 'string') lines.unshift('Reason: ' + detail.reason.replaceAll('_', ' ').toLowerCase());
    if (entry.kind === 'merged' && typeof detail.commit === 'string') lines.push('Landed at ' + detail.commit.slice(0, 12));
    if (entry.kind === 'main-moved') {
      if (Array.isArray(detail.items) && detail.items.length) lines.push('Items: ' + detail.items.map(id => '#' + id).join(', '));
      if (typeof detail.sha === 'string') lines.push('Main at ' + detail.sha.slice(0, 12));
    }
    return lines.map(line => '<p class="activity-evidence">' + esc(line).replaceAll('\n', '<br>') + '</p>').join('');
  };
  const row = entry => {
    let tone = 'note', glyph = 'note', content;
    if (entry.kind === 'sentinels') {
      tone = 'sentinel'; glyph = 'sentinel';
      const line = (finding, still = false) => {
        const text = finding.words;
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
      const recipient = entry.to === 'coordinator' ? 'the coordinator' : entry.to === 'person' ? 'the person'
        : /^item:\d+$/u.test(entry.to || '') ? 'the item’s followers' : entry.to || 'the board';
      content = '<p>' + who(entry.by, entry.agent) + ' ' + sentence + (entry.kind === 'shout' ? ' ' + esc(recipient) + about(entry) : '') + '</p>'
        + (entry.kind !== 'shout' && entry.item ? item(entry.item, entry.itemHref) : '') + (entry.kind === 'shout' && entry.words ? '<blockquote class="activity-quote">' + entry.quoteHtml + '</blockquote>' : '') + evidence(entry);
    }
    return sharedRowHtml({ variant: 'activity', state: tone, time: entry.timeLabel, iconHtml: icon(glyph), mainHtml: content,
      attributes: { 'data-activity-kind': entry.kind, ...(entry.kind === 'shout' && entry.by === 'coordinator' ? { 'data-activity-coordinator': 'true' } : {}) } });
  };

  const rows = model.rows.filter(entry => filter === 'all' || entry.category === filter);
  let day = '';
  const days = rows.map(entry => {
    const key = entry.dayKey;
    const heading = key === day ? '' : '<li class="activity-day"><h4 class="day">' + esc(entry.dayLabel) + '</h4></li>';
    day = key; return heading + row(entry);
  }).join('');
  return (controls ? activityFilters(model, filter) : '') + (rows.length ? '<ol class="activity-events">' + days + '</ol>' : '<p class="empty">No activity matches.</p>');
}

/** Render the same Activity filters in the standalone feed or beside the chart toggle [N26]. */
export function activityFilters(model, filter = 'all') {
  return '<div class="activity-bar">' + segmentedToggle({ label: 'Activity filter', attribute: 'data-activity-filter', value: filter, options: [['all', 'All'], ['work', 'Work'], ['sentinels', 'Sentinels'], ['shouts', 'Shouts']].map(([value, label]) => ({ value, label, count: model.counts[value] })) }) + '</div>';
}
