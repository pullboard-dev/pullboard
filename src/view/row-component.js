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
  const content = '<span class="dot ' + state + '">' + (row.iconHtml ?? '') + '</span><div><div class="t srow-text">' + primary
    + '</div>' + (time ? '<span class="row-age">' + time + '</span>' : '') + '<div class="meta">' + meta + '</div></div>' + chip;
  const classes = (tag === 'div' ? 'srow ' : '') + 'row s-' + state + (item ? ' item-row' : '') + (row.className ? ' ' + esc(row.className.trim()) : '');
  const attributes = row.attributesHtml ? ' ' + row.attributesHtml : attrs(row.attributes);
  const frame = ' class="' + classes + '"' + attributes + ' title="' + esc(row.title) + '"';
  if (row.detailHtml !== undefined) return '<' + tag + '><details class="row-disclosure"' + (row.open ? ' open' : '') + '><summary' + frame + '>' + content + '</summary><div class="row-detail">' + row.detailHtml + '</div></details></' + tag + '>';
  return '<' + tag + frame + '>' + content + '</' + tag + '>';
}
