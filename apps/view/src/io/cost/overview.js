/** Render a private costAnalytics/1 projection; arithmetic and attribution remain server-owned [N26]. */
export function costOverviewHtml(data = {}, opened = null, { vendorClasses = [], waiting = '', updating = false } = {}) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const duration = ms => ms == null ? '' : ms < 3600000 ? Math.max(1, Math.round(ms / 60000)) + ' min' : ms < 36000000 ? (ms / 3600000).toFixed(1) + ' h' : Math.round(ms / 3600000) + ' h';
  const percent = value => value == null ? '' : Math.round(value * 100) + '%';
  const bold = value => '<b>' + esc(value) + '</b>';
  const landed = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date) : ''; };
  const tokens = count => count >= 1e6 ? Math.round(count / 1e6) + 'M' : count >= 1e3 ? Math.round(count / 1e3) + 'K' : String(count);
  /** A model's vendor colour class: the first `vendorClasses` rule (from model-names.json) whose pattern matches the vendor or model name [P5]. */
  const vendorClass = value => vendorClasses.find(rule => new RegExp(rule.match, 'iu').test(value ?? ''))?.class ?? 'other';
  const dot = (label, vendor) => '<span class="cost-model-dot"><i class="' + vendorClass(vendor ?? label) + '" aria-hidden="true"></i>' + esc(label) + '</span>';
  const totals = data.totals ?? {}, back = totals.sentBack ?? {};
  const pill = value => ({ clear: ['clear', 'Clear'], leaning: ['lean', 'Leaning'], 'nothing-to-compare': ['more', 'Nothing to compare'] })[value];
  const track = (value, max, tone) => '<svg class="cost-time-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="100" height="6"></rect><rect class="' + tone + '" width="' + (max > 0 ? Math.min(100, 100 * value / max) : 0) + '" height="6"></rect></svg>';
  const calls = [['building', data.builders], ['verifying', data.verifiers]].map(([role, group]) => {
    const rows = group?.rows ?? [], best = rows.find(row => row.model === group?.best), runner = rows.find(row => row.model === group?.runnerUp), tone = pill(group?.verdict);
    if (!best || !tone) return '<div class="cost-verdict"><h3 class="hd2">' + role + '</h3><span class="cost-vtext">No model has enough observations yet.</span></div>';
    const lacking = rows.filter(row => !row.judged && row.model !== best.model).sort((a, b) => (b.built ?? b.accepts ?? 0) - (a.built ?? a.accepts ?? 0))[0];
    const call = role === 'building' ? (group.verdict === 'nothing-to-compare' ? best.label + ' builds' : best.label + ' builds best') : (group.verdict === 'nothing-to-compare' ? 'Keep ' + best.label + ' verifying' : best.label + ' verifies best');
    const why = role === 'building'
      ? bold(percent(best.rate)) + ' pass first time over ' + bold(best.built) + ' items' + (runner ? ', against ' + bold(percent(runner.rate)) + ' for ' + esc(runner.label) : '') + (best.typicalItemMs != null ? '. Typical item ' + bold(duration(best.typicalItemMs)) : '') + '.'
      : bold(percent(best.rate == null ? null : 1 - best.rate)) + ' of what it accepted came back later, over ' + bold(best.accepts) + ' accepts.' + (runner ? '' : ' No other model has 30 accepts yet.');
    const next = group.verdict === 'clear' ? 'Put it on your ' + (role === 'building' ? 'build' : 'verify') + ' seats.'
      : group.verdict === 'leaning' ? 'Keep it on most ' + (role === 'building' ? 'build' : 'verify') + ' seats. The ranges overlap, so more items will settle it.'
      : lacking ? 'Give ' + esc(lacking.label) + ' a few ' + (role === 'building' ? 'build' : 'verify') + ' seats until it has 30' + (role === 'building' ? ' builds' : ' accepts') + ', to compare.' : 'Give a second model seats until it reaches 30.';
    const plain = (why + ' ' + next).replace(/<[^>]+>/gu, '');
    return '<div class="cost-verdict"><h3 class="hd2">' + role + '</h3><p class="cost-call">' + dot(call, best.vendor).replace('<span class="cost-model-dot">', '<span class="cost-call-dot">') + '</p><span class="cost-vtext" title="' + esc(plain) + '">' + why + ' <span class="cost-next">' + next + '</span></span><span class="cost-conf">' + tone[1] + '</span></div>';
  }).join('');
  const dayHours = day => ((day.firstTimeMs ?? 0) + (day.sentBackMs ?? 0)) / 3600000;
  const peak = Math.max(0, ...(data.days ?? []).map(dayHours));
  const raw = Math.max(peak, 0.1) / 4, magnitude = 10 ** Math.floor(Math.log10(raw)), step = ([1, 2, 2.5, 5, 10].find(m => m * magnitude >= raw) ?? 10) * magnitude, top = step * 4 * (peak > step * 4 * 0.9 ? 1.25 : 1);
  const plotW = 640, plotH = 200, left = 34, count = Math.max(1, (data.days ?? []).length), slot = (plotW - left) / count, barW = Math.min(90, slot - 14);
  const weekday = (date, options) => { const at = new Date(date + 'T12:00:00Z'); return Number.isFinite(at.getTime()) ? new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...options }).format(at) : date; };
  const known = (data.days ?? []).filter(day => day.firstTimeMs != null && day.sentBackMs != null);
  const bars = (data.days ?? []).map((day, index) => {
    const x = left + slot * index + (slot - barW) / 2, center = x + barW / 2, label = '<text class="x" x="' + center + '" y="' + (plotH + 18) + '" text-anchor="middle">' + esc(weekday(day.date, { weekday: 'short' })) + '</text><text class="n" x="' + center + '" y="' + (plotH + 32) + '" text-anchor="middle">' + esc(day.items) + ' items</text>';
    // A day with items but no recorded time says so in its column, never an empty gap: two lines where the column
    // is wide, upright along the column where it is narrow, so neighbouring labels never run together [N26].
    const unrecorded = slot >= 70
      ? '<text class="unrecorded" x="' + center + '" y="' + (plotH - 22) + '" text-anchor="middle"><tspan x="' + center + '">time not</tspan><tspan x="' + center + '" dy="13">recorded</tspan></text>'
      : '<text class="unrecorded" x="' + center + '" y="' + (plotH - 6) + '" transform="rotate(-90 ' + center + ' ' + (plotH - 6) + ')" dominant-baseline="central">time not recorded</text>';
    if (day.firstTimeMs == null || day.sentBackMs == null) return '<g class="cost-chart-day"><title>' + esc(weekday(day.date, { weekday: 'long', month: 'short', day: 'numeric' }) + '\n' + day.items + ' items landed\nTime not recorded') + '</title>' + unrecorded + label + '</g>';
    const first = day.firstTimeMs / 3600000 / top * plotH, sent = day.sentBackMs / 3600000 / top * plotH, base = plotH - first;
    const tooltip = weekday(day.date, { weekday: 'long', month: 'short', day: 'numeric' }) + '\n' + day.items + ' items landed\nRight first time ' + duration(day.firstTimeMs) + ' · Sent back ' + duration(day.sentBackMs);
    return '<g class="cost-chart-day"><title>' + esc(tooltip) + '</title><svg class="cost-chart-bar" x="' + x + '" y="0" width="' + barW + '" height="' + plotH + '" viewBox="0 0 ' + barW + ' ' + plotH + '" preserveAspectRatio="none"><rect class="right" x="0" y="' + base + '" width="' + barW + '" height="' + first + '"></rect><rect class="back" x="0" y="' + (base - sent) + '" width="' + barW + '" height="' + sent + '"></rect></svg><text class="v" x="' + center + '" y="' + Math.max(11, base - sent - 5) + '" text-anchor="middle">' + esc(duration(day.firstTimeMs + day.sentBackMs).replace(' min', ' min')) + '</text>' + label + '</g>';
  }).join('');
  const ticks = [0, 1, 2, 3, 4].map(i => '<text class="y" x="' + (left - 8) + '" y="' + (plotH - plotH * i / 4 + 4) + '" text-anchor="end">' + esc(Number((top * i / 4).toFixed(2))) + '</text>' + (i ? '<line class="grid" x1="' + left + '" x2="' + plotW + '" y1="' + (plotH - plotH * i / 4) + '" y2="' + (plotH - plotH * i / 4) + '"></line>' : '')).join('');
  const chart = '<svg class="cost-chart-plot" viewBox="0 0 ' + plotW + ' ' + (plotH + 40) + '" role="img" aria-label="Agent time each day, in hours">' + ticks + '<line class="axis" x1="' + left + '" x2="' + plotW + '" y1="' + plotH + '" y2="' + plotH + '"></line>' + bars + '</svg>';
  const interval = (original, role) => {
    if (!original) return '<span class="faint">—</span>';
    if (original.tooFew || original.low == null || original.high == null) return '<span class="faint">too few</span>';
    const row = role === 'verifying' ? { ...original, rate: original.rate == null ? null : 1 - original.rate, low: 1 - original.high, high: 1 - original.low } : original;
    const tone = vendorClass(original.vendor);
    return '<span class="cost-range-cell"><svg class="cost-range ' + tone + '" viewBox="0 0 120 10" aria-label="95 percent interval ' + esc(percent(row.low)) + ' to ' + esc(percent(row.high)) + '"><line class="axis" x1="0" x2="120" y1="5" y2="5"></line><rect class="band" x="' + (120 * row.low) + '" y="2" width="' + Math.max(2, 120 * (row.high - row.low)) + '" height="6" rx="3"></rect><circle cx="' + Math.min(115, Math.max(5, 120 * row.rate)) + '" cy="5" r="4.5"></circle></svg><b>' + esc(percent(row.rate)) + '</b></span>';
  };
  const models = new Map();
  for (const row of data.builders?.rows ?? []) models.set(row.model, { building: row });
  for (const row of data.verifiers?.rows ?? []) models.set(row.model, { ...models.get(row.model), verifying: row });
  const rows = [...models.values()].map(({ building, verifying }) => {
    const name = building ?? verifying, few = !(building?.judged || verifying?.judged);
    return '<tr' + (few ? ' class="few"' : '') + '><th scope="row"><span class="cost-model-name"><i class="' + vendorClass(name.vendor) + '" aria-hidden="true"></i>' + esc(name.label) + ' <small>' + esc(name.vendor) + '</small></span></th><td>' + (building ? esc(building.built) : '<span class="faint">—</span>') + '</td><td>' + interval(building, 'building') + '</td><td>' + (building && !building.tooFew && building.typicalItemMs != null ? esc(duration(building.typicalItemMs)) : '<span class="faint">—</span>') + '</td><td class="vsep">' + (verifying ? esc(verifying.verdicts) : '<span class="faint">—</span>') + '</td><td>' + interval(verifying, 'verifying') + '</td></tr>';
  }).join('');
  /** One dense table of hours, share and sent-back share per model or per lane [N26]. */
  const spreadList = (title, list) => '<div class="cost-spread"><div class="cost-spread-head"><h3 class="hd2">' + title + '</h3><span>Hours</span><span>Share</span><span>Sent back</span></div>' + (list ?? []).map(row => '<div class="cost-spread-row"><span class="cost-spread-name">' + (title === 'By model' ? dot(row.label, row.key ?? row.label) : esc(row.label)) + '</span><b>' + esc(duration(row.agentMs)) + '</b><span>' + esc(percent(row.share)) + '</span><span class="' + (row.sentBackShare > 0 ? 'bad' : 'faint') + '">' + esc(percent(row.sentBackShare)) + '</span></div>').join('') + ((list ?? []).length ? '' : '<p class="cost-note">Not recorded yet.</p>') + '</div>';
  const share = back.agentMsShare, firstMs = totals.agentMs != null && back.agentMs != null ? totals.agentMs - back.agentMs : null;
  const lock = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"></rect><path d="M5.5 7V5.2a2.5 2.5 0 015 0V7" fill="none" stroke="currentColor" stroke-width="1.5"></path></svg>';
  const heading = '<section class="cost-page" aria-label="Cost"><div class="shd cost-private-row"><span class="cap2 cost-private">' + lock + 'Only you see this</span>' + (updating ? '<span class="cap2 cost-updating" role="status">Updating…</span>' : '') + '</div>';
  if (waiting) return heading + '<section class="cost-card cost-waiting" role="status">' + esc(waiting) + '</section></section>';
  return heading
    + '<section class="cost-sect"><div class="shd"><h2 class="hd1">Models</h2><span class="cap2">Which models earn their seat</span></div><div class="cost-card cost-model-card"><div class="cost-model-calls">' + calls + '</div><div class="cost-model-table-wrap"><table class="cost-model-table"><thead><tr><th class="grp-gap"></th><th colspan="3" class="grp">Building</th><th colspan="2" class="grp vsep">Verifying</th></tr><tr><th>Model</th><th>Built</th><th>Passed first time <span class="sm">· bar shows likely range</span></th><th>Typical item</th><th class="vsep">Verdicts</th><th>Accepted, came back later</th></tr></thead><tbody>' + rows + '</tbody></table></div></div></section>'
    + '<section class="cost-sect"><div class="shd"><h2 class="hd1">Agent time</h2></div><div class="cost-card cost-overview"><article class="cost-summary"><div class="cost-line"><b class="cost-total">' + (totals.agentMs == null ? 'Not recorded' : esc(duration(totals.agentMs))) + '</b><span>' + bold(totals.itemCount) + ' landed items</span><span>' + bold(duration(totals.medianItemMs) || '—') + ' typical item</span><span title="Sent back: a reject or a reopen, as the Dashboard and Pipeline count it"><b class="bad">' + esc(percent(back.itemShare)) + '</b> of items sent back' + (share == null ? '' : ', <b class="bad">' + esc(percent(share)) + '</b> of the time') + (back.agentMs == null ? '' : ' · ' + bold(duration(back.agentMs))) + '</span></div>'
    + (share == null ? '' : '<svg class="cost-split" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="Agent time split"><rect class="right" width="' + Math.max(0, 100 * (1 - share) - 0.5) + '" height="10"></rect><rect class="back" x="' + (100 * (1 - share) + 0.5) + '" width="' + Math.max(0, 100 * share - 0.5) + '" height="10"></rect></svg>')
    + '<div class="cost-spreads">' + spreadList('By model', data.byModel) + spreadList('By lane', data.byLane) + '</div></article>'
    + '<article class="cost-chart"><div class="cost-chart-head"><h3 class="hd2">Agent time each day</h3><span class="cost-chart-legend"><span><i></i>Right first time</span><span><i class="back"></i>Sent back</span></span></div>' + (known.length || (data.days ?? []).length ? chart : '') + '</article></div></section></section>';
}

/** Bind the Cost controls to the host's private projection and navigation services [N26]. */
export function bindCostOverview(element, { readWindow, openItem, showAll } = {}) {
  let selected = '7d', opened = null, model = null;
  /** Refresh only the currently selected window, ignoring late responses from earlier selections. */
  async function load(window) {
    selected = window;
    try {
      const result = await readWindow(window);
      if (selected !== window) return;
      model = result;
      element.innerHTML = costOverviewHtml(model, opened, { vendorClasses: modelTables.vendorClasses });
      element.querySelector('[data-cost-window="' + window + '"]')?.focus();
    } catch (error) {
      if (selected !== window) return;
      element.textContent = 'Cost history is unavailable. ' + String(error?.message ?? error);
    }
  }
  element.addEventListener('click', event => {
    const target = event.target.closest('[data-cost-window],[data-cost-row],[data-cost-all],[data-go]');
    if (!target) return;
    if (target.dataset.costWindow) { void load(target.dataset.costWindow); return; }
    if (target.dataset.costAll !== undefined) { showAll(); return; }
    if (target.dataset.go?.startsWith('item:')) { event.preventDefault(); openItem(Number(target.dataset.go.slice(5))); return; }
    if (target.dataset.costRow) { const id = Number(target.dataset.costRow); opened = opened === id ? null : id; element.innerHTML = costOverviewHtml(model, opened, { vendorClasses: modelTables.vendorClasses }); element.querySelector('[data-cost-row="' + id + '"]')?.focus(); }
  });
  return load(selected);
}
