/** One data-driven row frame; accepted Needs and Activity layouts remain explicit variants [N26]. */
export function sharedRowHtml(row) {
  const variant = row.variant ?? 'item';
  if (!['needs', 'activity', 'item', 'record', 'timeline'].includes(variant)) throw new TypeError('unknown row variant');
  /** Escape board data; only explicitly named Html slots contain trusted caller-rendered markup. */
  const esc = value => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** Reusable rows accept presentation and native data attributes, never event handlers. */
  const attrs = values => Object.entries(values ?? {}).map(([key, value]) => {
    if (!/^(?:data-[a-z0-9-]+|aria-[a-z0-9-]+|title|role|id|tabindex)$/u.test(key)) throw new TypeError('unsupported row attribute');
    return value === undefined || value === null ? '' : ' ' + key + '="' + esc(value) + '"';
  }).join('');
  if (variant === 'timeline') {
    return '<li class="' + esc(row.className) + '"' + attrs(row.attributes) + '>'
      + '<span class="tl-marker ' + esc(row.state) + '" aria-hidden="true">' + (row.iconHtml ?? '') + '</span>'
      + '<div class="tl-content"><div class="tl-heading"><span class="tl-sentence">' + (row.mainHtml ?? '') + '</span><time>' + esc(row.time) + '</time></div>'
      + (row.metaHtml ? '<small>' + row.metaHtml + '</small>' : '') + (row.bodyHtml ?? '') + '</div></li>';
  }
  const needs = variant === 'needs', activity = variant === 'activity';
  if (needs || activity) {
    const markerClass = needs ? 'needs-kind needs-kind-' + row.state : 'activity-verb ' + row.state;
    const marker = '<span class="' + esc(markerClass) + '"' + (needs ? ' aria-hidden="true"' : '') + '>' + (row.iconHtml ?? '') + '</span>';
    const title = '<span class="needs-id" title="' + esc(row.id) + '">' + esc(row.id) + '</span>' + esc(row.title);
    const main = needs ? '<span class="needs-copy"><b>' + title + '</b><small>' + esc(row.meta) + '</small></span>'
      : '<div class="activity-say">' + (row.mainHtml ?? '') + '</div>';
    const time = activity ? '<time>' + esc(row.time) + '</time>' : '<span class="needs-age">' + (row.timeHtml ?? esc(row.time)) + '</span>';
    const side = needs ? '<span class="needs-side">' + time + '<span class="needs-action needs-action-' + esc(row.state) + '">' + esc(row.chip)
      + '</span><span class="needs-caret" aria-hidden="true">›</span></span>' : '';
    const content = activity ? time + marker + main : marker + main + side;
    const inside = needs ? '<details' + attrs(row.detailsAttributes) + (row.open ? ' open' : '') + '><summary>' + content + '</summary>' + (row.detailHtml ?? '') + '</details>' : content;
    return '<li class="' + (needs ? 'needs-call ' + esc(row.className ?? '') : 'activity-event') + '"' + attrs(row.attributes) + '>' + inside + '</li>';
  }
  const tag = row.tag ?? 'li';
  if (!['li', 'div'].includes(tag)) throw new TypeError('unsupported row tag');
  const state = esc(row.state), item = variant === 'item';
  const primary = row.primaryHtml ?? '<span>' + esc(row.id) + '</span>' + esc(row.title);
  const meta = row.metaHtml ?? esc(row.meta);
  const time = row.timeHtml ?? esc(row.time);
  const chip = row.chipHtml ?? (row.chip ? '<span class="chip ' + state + '"' + attrs({ title: row.chipTitle }) + '>' + esc(row.chip) + '</span>' : '');
  const paths = {
    building: '<path d="m9.5 2.5 4 4-1.5 1.5-4-4zM8 4 2.5 9.5l4 4L12 8"/>',
    back: '<path d="m6 4-3.5 3.5L6 11M2.5 7.5H10a3.5 3.5 0 0 1 0 7H8"/>',
    verify: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
    verified: '<path d="m3.5 8.5 3 3 6-6.5"/>',
  };
  const glyph = item && paths[row.state] ? '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + paths[row.state] + '</svg>' : '';
  const seatStage = row.seatStage;
  const seatLabel = seatStage ? seatStage.stage + ': ' + seatStage.detail : null;
  const seat = '<span class="chip item-seat ' + state + '"' + attrs({ title: [row.chipTitle, seatLabel].filter(Boolean).join(' · ') || null, 'aria-label': seatLabel }) + '>' + glyph + esc(row.seat) + '</span>';
  const seatChip = item && row.seat ? (seatStage ? '<span class="item-stage"' + attrs({ 'data-stage': seatStage.key, role: 'group', title: seatStage.detail, 'aria-label': seatLabel }) + '><span class="stage-line">' + seat
    + (seatStage.marksHtml ? '<span class="stage-marks">' + seatStage.marksHtml + '</span>' : '') + '</span><small class="stage-detail"' + attrs({ title: seatStage.detail }) + '>' + esc(seatStage.detail) + '</small></span>' : seat) : chip;
  const marker = '<span class="dot ' + state + '" aria-hidden="true">' + (row.iconHtml ?? glyph) + '</span>';
  const copy = '<div class="row-copy"><div class="t srow-text">' + primary + '</div><div class="meta">' + meta + '</div></div>';
  const age = time ? '<span class="row-age">' + time + '</span>' : '';
  const content = item ? marker + copy + '<span class="row-side">' + age + seatChip + '</span>'
    : marker + '<div><div class="t srow-text">' + primary + '</div>' + age + '<div class="meta">' + meta + '</div></div>' + chip;
  const classes = (tag === 'div' ? 'srow ' : '') + 'row s-' + state + (item ? ' item-row' : '') + (row.className ? ' ' + esc(row.className.trim()) : '');
  const attributes = row.attributesHtml ? ' ' + row.attributesHtml : attrs(row.attributes);
  const frame = ' class="' + classes + '"' + attributes + ' title="' + esc(row.title) + '"';
  if (row.detailHtml !== undefined) return '<' + tag + '><details class="row-disclosure"' + (row.open ? ' open' : '') + '><summary' + frame + '>' + content + '</summary><div class="row-detail">' + row.detailHtml + '</div></details></' + tag + '>';
  return '<' + tag + frame + '>' + content + '</' + tag + '>';
}
