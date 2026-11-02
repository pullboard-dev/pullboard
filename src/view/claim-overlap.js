/**
 * The words that tell a builder's overlap with other claimed work: each other item with its builder and the files they
 * share, and any changed files that belong to other open items. Empty when the item has neither, so a row says nothing
 * about work that does not collide [N2].
 *
 * @param {{overlaps?: {item: number, builder: string, files: string[]}[], outOfScope?: {item: number, files: string[]}[]}|undefined} entry - One value of the state's claimOverlaps.
 * @returns {string[]} One plain sentence per other item.
 */
export function overlapLines(entry) {
  const list = files => (Array.isArray(files) ? files : []).join(', ');
  const overlaps = (Array.isArray(entry?.overlaps) ? entry.overlaps : [])
    .map(other => 'Same files as #' + other.item + (other.builder ? ' (' + other.builder + ')' : '') + ': ' + list(other.files));
  const outside = (Array.isArray(entry?.outOfScope) ? entry.outOfScope : [])
    .map(other => 'Out of scope, belongs to #' + other.item + ': ' + list(other.files));
  return [...overlaps, ...outside];
}

/**
 * The overlap text for one item's row or detail, escaped, one line per other item. Empty when nothing overlaps.
 *
 * @param {Record<string, object>|undefined} claimOverlaps - The state's claimOverlaps, keyed by item id.
 * @param {number|string} id - The item's id.
 * @returns {string} HTML, or an empty string.
 */
export function overlapHtml(claimOverlaps, id) {
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  // Self-contained: the page script embeds this function's source alone, so it cannot call overlapLines.
  const entry = claimOverlaps?.[id], list = files => (Array.isArray(files) ? files : []).join(', ');
  const lines = [...(Array.isArray(entry?.overlaps) ? entry.overlaps : []).map(other => 'Same files as #' + other.item + (other.builder ? ' (' + other.builder + ')' : '') + ': ' + list(other.files)),
    ...(Array.isArray(entry?.outOfScope) ? entry.outOfScope : []).map(other => 'Out of scope, belongs to #' + other.item + ': ' + list(other.files))];
  return lines.map(line => '<span class="claim-overlap" role="note">' + escape(line) + '</span>').join('');
}
