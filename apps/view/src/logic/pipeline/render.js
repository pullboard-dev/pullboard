/** Render prepared pipeline rows as HTML without reading navigation, clocks or browser state [N26,N38].
 * Each row supplies the API-derived stage, arrival time, resolved address and rendered age.
 */
export function pipelineHtml(items, { selectedId = null } = {}) {
  /** Escape board text and the already-resolved address at their HTML boundary. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const stages = [['blocked', 'Blocked'], ['ready', 'Ready'], ['building', 'Building'], ['in-review', 'In review'], ['verified', 'Verified'], ['landing', 'Landing'], ['merged', 'Merged']];
  return stages.map(([stage, label]) => {
    const rows = items.filter(item => item.stageKey === stage).sort((a, b) => a.since.localeCompare(b.since) || a.id - b.id);
    const oldest = rows[0];
    return '<li class="card-panel pipeline-stage" data-pipeline-stage="' + stage + '"><header><h2>' + label + '</h2><b data-stage-count="' + stage + '">' + rows.length + '</b></header>'
      + (oldest ? '<p class="pipeline-oldest">Oldest <a class="ref" href="' + esc(oldest.href) + '" data-go="item:' + oldest.id + '">#' + oldest.id + '</a> · ' + oldest.ageHtml + ' in this stage</p>' : '<p class="pipeline-oldest">No items</p>')
      + '<ul>' + rows.map(item => '<li><button class="pipeline-item' + (selectedId === item.id ? ' on' : '') + '" type="button" data-item="' + item.id + '"><span>#' + item.id + '</span><span class="pipeline-copy"><b>' + esc(item.title) + '</b>' + (item.stageHtml || '') + '</span></button></li>').join('') + '</ul></li>';
  }).join('');
}
