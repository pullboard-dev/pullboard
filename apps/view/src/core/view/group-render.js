/** Cross-repository groups receive explicit labels and already prepared rich text [N26,C7]. */

/** Select the same bounded, newest-first event stream from supplied board snapshots. */
export function groupActivityModel(repos) {
  return repos.flatMap(repo => {
    const titles = new Map(repo.board.items.map(item => [String(item.id), item.title]));
    return repo.board.events.map(event => ({ ...event, repo, titles, title: event.item_id ? titles.get(String(event.item_id)) : null }));
  }).sort((a, b) => b.event_at.localeCompare(a.event_at)).slice(0, 80);
}

/** Render prepared person calls while keeping their repository and action identities intact. */
export function groupNeedsHtml(rows) {
  /** Labels and navigation identities are data, not trusted HTML. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return rows.length ? rows.map(row => '<div class="group-need"><b>' + esc(row.repoName) + '</b><code>' + esc(row.ref) + '</code><span>' + row.textHtml + '</span><button data-root="' + esc(row.repoRoot) + '" type="button"><em>' + esc(row.actionLabel) + (row.ageHtml ? ', ' + row.ageHtml : '') + ' →</em></button></div>').join('') : '<div class="empty">Nothing needs you across this project.</div>';
}

/** Render a single event after the browser adapter has supplied dates, names and scoped rich links. */
export function groupEventHtml(row) {
  /** Escape the plain fields while preserving only explicitly prepared title markup. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return '<div><time>' + esc(row.timeLabel) + '</time><div class="act"><b class="repo-label">' + esc(row.repoName) + '</b> <span>' + esc(row.agentLabel) + ' ' + esc(row.kind)
    + (row.itemId ? ' <a class="ref" href="' + esc(row.itemHref) + '" data-go="item:' + esc(row.itemId) + '"' + (row.foreignRoot ? ' data-board="' + esc(row.foreignRoot) + '"' : '') + '>#' + esc(row.itemId) + '</a>' + (row.titleHtml ? ' ' + row.titleHtml : '') : '') + '</span></div></div>';
}
