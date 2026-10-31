/** Render a private costAnalytics/1 projection; arithmetic and attribution remain server-owned [N26]. */
export function costOverviewHtml(data = {}, opened = null, { hasPrices = false } = {}) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const duration = ms => ms == null ? '' : ms >= 3600000 ? (ms / 3600000).toFixed(1) + ' h' : Math.round(ms / 60000) + ' min';
  const percent = value => value == null ? '' : Math.round(value * 100) + '%';
  const totals = data.totals ?? {}, back = totals.sentBack ?? {};
  const verdict = value => ({ clear: 'Clear', leaning: 'Leaning', 'nothing-to-compare': 'Nothing to compare' })[value] ?? '';
  const calls = [['building', data.builders], ['verifying', data.verifiers]].map(([role, group]) => {
    const best = group?.rows?.find(row => row.model === group.best), runner = group?.rows?.find(row => row.model === group.runnerUp);
    const why = best ? (role === 'building' ? percent(best.rate) + ' passed first time over ' + best.built + ' items' : percent(best.rate == null ? null : 1 - best.rate) + ' of ' + best.accepts + ' accepts came back later') : 'No model has enough observations yet.';
    const next = group?.verdict === 'nothing-to-compare' ? 'Give a second model seats until it reaches 30.' : group?.verdict === 'leaning' ? 'The ranges overlap; more items will settle it.' : group?.verdict === 'clear' ? 'Keep it on most seats.' : '';
    return '<article class="cost-model-call"><span class="cost-kicker">' + role + '</span><span class="cost-confidence">' + esc(verdict(group?.verdict)) + '</span><h3>' + (best ? esc(best.label) : '') + '</h3><p>' + esc(why) + (runner ? ' · compared with ' + esc(runner.label) : '') + '</p><p>' + esc(next) + '</p></article>';
  }).join('');
  const dayMax = Math.max(1, ...(data.days ?? []).map(day => (day.firstTimeMs ?? 0) + (day.sentBackMs ?? 0)));
  const days = (data.days ?? []).map(day => {
    if (day.firstTimeMs == null || day.sentBackMs == null) return '<div class="cost-chart-day"><b>' + esc(day.date) + '</b><small>' + esc(day.items) + ' items</small></div>';
    const first = Math.max(0, day.firstTimeMs ?? 0), sent = Math.max(0, day.sentBackMs ?? 0), total = first + sent;
    const tooltip = day.date + ': ' + duration(day.firstTimeMs) + ' right first time, ' + duration(day.sentBackMs) + ' sent back';
    return '<div class="cost-chart-day" title="' + esc(tooltip) + '"><span class="cost-day-total">' + esc(duration(total)) + '</span><svg class="cost-chart-bar" viewBox="0 0 100 ' + dayMax + '" preserveAspectRatio="none" aria-hidden="true"><rect class="first" x="0" y="' + (dayMax - first) + '" width="100" height="' + first + '"></rect><rect class="back" x="0" y="' + (dayMax - total) + '" width="100" height="' + sent + '"></rect></svg><b>' + esc(day.date) + '</b><small>' + esc(day.items) + ' items</small></div>';
  }).join('');
  const interval = (original, role) => {
    if (!original) return '';
    const row = role === 'verifying' ? { ...original, rate: original.rate == null ? null : 1 - original.rate, low: original.high == null ? null : 1 - original.high, high: original.low == null ? null : 1 - original.low } : original;
    return row.tooFew ? 'too few' : (row.low == null || row.high == null ? '' : '<svg class="cost-range" viewBox="0 0 100 8" aria-label="95 percent interval ' + esc(percent(row.low)) + ' to ' + esc(percent(row.high)) + '"><line x1="' + (100 * row.low) + '" x2="' + (100 * row.high) + '" y1="4" y2="4"></line><circle cx="' + (100 * row.rate) + '" cy="4" r="2"></circle></svg>') + esc(percent(row.rate));
  };
  const models = new Map();
  for (const row of data.builders?.rows ?? []) models.set(row.model, { building: row });
  for (const row of data.verifiers?.rows ?? []) models.set(row.model, { ...models.get(row.model), verifying: row });
  const rows = [...models.values()].map(({ building, verifying }) => {
    const name = building ?? verifying;
    return '<tr><th><span class="cost-model-dot"><i aria-hidden="true"></i>' + esc(name.label) + '</span> <small>' + esc(name.vendor) + '</small></th><td>' + esc(building?.built) + '</td><td>' + interval(building, 'building') + '</td><td>' + esc(duration(building?.typicalItemMs)) + '</td><td>' + esc(verifying?.verdicts) + '</td><td>' + interval(verifying, 'verifying') + '</td></tr>';
  }).join('');
  const longestMax = Math.max(1, ...(data.longest ?? []).map(row => row.agentMs ?? 0));
  const items = (data.longest ?? []).map(row => {
    const sessions = opened === row.id ? '<div class="cost-detail">' + (row.sessions ?? []).map(s => '<div class="cost-session"><b>' + esc(s.label) + '</b><span>' + (s.count == null ? '' : esc(s.count) + ' sessions') + '</span>' + (s.agentMs == null ? '' : '<svg class="cost-time-bar" viewBox="0 0 ' + Math.max(1, row.agentMs ?? s.agentMs) + ' 1" preserveAspectRatio="none" aria-hidden="true"><rect class="first" width="' + esc(s.agentMs) + '" height="1"></rect></svg>') + '<span>' + esc(duration(s.agentMs)) + '</span><span>' + (s.tokensIn == null ? 'No token count' : esc(s.tokensIn) + ' tokens in') + '</span></div>').join('') + (row.sentBack ? '<span>Sent back ' + esc(row.sentBack) + '×</span>' : '') + (row.verifiedBy ? '<span>Verified by ' + esc(row.verifiedBy) + '</span>' : '') + (row.landedAt ? '<time>' + esc(row.landedAt) + '</time>' : '') + '<a href="/items/' + esc(row.id) + '" data-go="item:' + esc(row.id) + '">Open #' + esc(row.id) + ' →</a></div>' : '';
    return '<button class="cost-row" type="button" data-cost-row="' + esc(row.id) + '" aria-expanded="' + (opened === row.id) + '"><b>#' + esc(row.id) + '</b><span class="cost-title">' + esc(row.title) + '</span><span>' + (row.sessions ?? []).map(s => '<span class="cost-model-dot"><i aria-hidden="true"></i>' + esc(s.label) + '</span>').join(' ') + '</span>' + (row.agentMs == null ? '' : '<svg class="cost-time-bar" viewBox="0 0 ' + longestMax + ' 1" preserveAspectRatio="none" aria-hidden="true"><rect class="' + (row.sentBack ? 'back' : 'first') + '" width="' + esc(row.agentMs ?? 0) + '" height="1"></rect></svg>') + '<span>' + esc(duration(row.agentMs)) + '</span>' + (row.sentBack ? '<span class="chip no">' + esc(row.sentBack) + '× back</span>' : '') + '</button>' + sessions;
  }).join('');
  return '<section class="cost-page" aria-label="Cost"><header class="cost-heading"><h1>Cost</h1><nav class="cost-periods" aria-label="Time period">' + [['today','Today'],['7d','7 days'],['30d','30 days']].map(([id,label]) => '<button data-cost-window="' + id + '" aria-pressed="' + (data.window === id) + '">' + label + '</button>').join('') + '</nav><span class="cost-private"><span aria-hidden="true">🔒</span> Only you see this</span></header>' + (hasPrices ? '' : '<p>Showing agent time. <b>Want dollars?</b> Tell your coordinator agent: <code>Add model prices to Pullboard</code> <button data-cost-copy>Copy</button></p>')
    + '<div class="cost-overview"><article class="cost-summary"><span class="cost-kicker">Agent time</span><h2>' + esc(duration(totals.agentMs)) + '</h2><p>' + esc(totals.itemCount) + ' landed items · ' + esc(duration(totals.medianItemMs)) + ' for a typical item</p><h3>Sent back</h3><p>' + esc(percent(back.itemShare)) + ' of items were sent back. They took ' + esc(percent(back.agentMsShare)) + ' of the time.</p>' + (back.agentMsShare == null ? '' : '<svg class="cost-split" viewBox="0 0 100 1" preserveAspectRatio="none" aria-label="Agent time split"><rect class="first" width="' + (100 * (1 - back.agentMsShare)) + '" height="1"></rect><rect class="back" x="' + (100 * (1 - back.agentMsShare)) + '" width="' + (100 * back.agentMsShare) + '" height="1"></rect></svg>') + '</article><article class="cost-chart"><div class="cost-chart-head"><span class="cost-kicker">Agent time each day</span><span class="cost-chart-legend"><span><i></i>Right first time</span><span><i class="back"></i>Sent back</span></span></div><div class="cost-chart-days">' + days + '</div></article></div><section class="cost-model-card"><h2>Models</h2><p>Which models earn their seat</p><div class="cost-model-calls">' + calls + '</div><p>' + esc(percent(data.unknownBuilderModelShare)) + ' of items have no recorded builder model.</p><div class="cost-model-table-wrap"><table class="cost-model-table"><thead><tr><th rowspan="2">Model</th><th colspan="3">Building</th><th colspan="2">Verifying</th></tr><tr><th>Built</th><th>Passed first time</th><th>Typical item</th><th>Verdicts</th><th>Accepted came back later</th></tr></thead><tbody>' + rows + '</tbody></table></div></section><section class="cost-longest"><h2>Took the longest</h2>' + items + '<button data-cost-all>All ' + esc(data.allItems) + ' items →</button></section></section>';
}

/** Bind the Cost controls to the host's private projection and navigation services [N26]. */
export function bindCostOverview(element, { readWindow, openItem, showAll, copyText, hasPrices = false } = {}) {
  let selected = '7d', opened = null, model = null;
  /** Refresh only the currently selected window, ignoring late responses from earlier selections. */
  async function load(window) {
    selected = window;
    try {
      const result = await readWindow(window);
      if (selected !== window) return;
      model = result;
      element.innerHTML = costOverviewHtml(model, opened, { hasPrices });
      element.querySelector('[data-cost-window="' + window + '"]')?.focus();
    } catch (error) {
      if (selected !== window) return;
      element.textContent = 'Cost history is unavailable. ' + String(error?.message ?? error);
    }
  }
  element.addEventListener('click', event => {
    const target = event.target.closest('[data-cost-window],[data-cost-row],[data-cost-copy],[data-cost-all],[data-go]');
    if (!target) return;
    if (target.dataset.costWindow) { void load(target.dataset.costWindow); return; }
    if (target.dataset.costCopy !== undefined) { void copyText('Add model prices to Pullboard'); return; }
    if (target.dataset.costAll !== undefined) { showAll(); return; }
    if (target.dataset.go?.startsWith('item:')) { event.preventDefault(); openItem(Number(target.dataset.go.slice(5))); return; }
    if (target.dataset.costRow) { const id = Number(target.dataset.costRow); opened = opened === id ? null : id; element.innerHTML = costOverviewHtml(model, opened, { hasPrices }); element.querySelector('[data-cost-row="' + id + '"]')?.focus(); }
  });
  return load(selected);
}
