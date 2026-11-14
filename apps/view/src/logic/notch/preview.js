/**
 * The notch's hover preview and rulings list: one centred panel under the notch, over a blurred page [N26].
 * The approved prototype is nav-switch-approved-1112. Every function here uses only its arguments and the language's
 * globals, so the page script may embed its source text, as it does for the other view renderers. The page's
 * stylesheet policy refuses inline styles, so each bar is an SVG whose widths are attributes.
 */

/**
 * Markup for one panel of the notch, from data the page already holds; reading it never touches the board.
 *
 * @param {object} data - { agents, perHour, rulings }, as notchPreviewData builds it.
 * @param {'agents'|'perHour'|'rulings'|'list'} which - The preview to draw, or the full rulings list.
 * @returns {string} The panel's inner markup, or '' when `which` names nothing.
 */
export function notchPreviewHtml(data, which) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ICONS = {
    build: '<path d="M9 3l4 4-6 6-4-4z"/><path d="M3 13l2-2"/>',
    review: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    idle: '<path d="M6 4v8M10 4v8"/>',
    land: '<path d="M3 8.5l3 3 7-7"/>',
    pace: '<path d="M2 12l4-4 3 3 5-6"/><path d="M10 5h4v4"/>',
    back: '<path d="M6 4L2.5 7.5 6 11"/><path d="M3 7.5h7a3.5 3.5 0 0 1 0 7H8"/>',
    spec: '<path d="M4 2.5h6l2.5 2.5v8.5H4z"/><path d="M6.5 8h4M6.5 10.5h4"/>',
    item: '<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M5.5 7h5M5.5 9.5h3"/>',
    rigor: '<path d="M8 2l5.5 10.5h-11z"/><path d="M8 6.5v3M8 11.2v.1"/>',
    ship: '<path d="M3 8.5l3 3 7-7"/>',
    data: '<ellipse cx="8" cy="4.5" rx="4.5" ry="2"/><path d="M3.5 4.5v7c0 1.1 2 2 4.5 2s4.5-.9 4.5-2v-7"/>',
  };
  const icon = kind => '<span class="np-ic np-' + esc(ICONS[kind] ? kind : 'idle') + '"><svg viewBox="0 0 16 16" aria-hidden="true">' + (ICONS[kind] || ICONS.idle) + '</svg></span>';
  const row = r => '<div class="np-d">' + icon(r.kind) + '<span class="np-tx"><b>' + esc(r.title) + '</b><small><em>' + esc(r.label) + '</em> · ' + esc(r.note) + '</small></span><span class="np-val' + (r.tone ? ' np-' + esc(r.tone) : '') + '">' + esc(r.value) + '</span></div>';
  const head = text => '<h4>' + esc(text) + '</h4>';
  const go = (label, target) => '<button class="np-go" type="button" data-notch-go data-go="' + esc(target) + '">' + esc(label) + ' ›</button>';
  const share = (value, total) => total > 0 ? Math.round(value / total * 100) : 0;
  const a = data && data.agents, h = data && data.perHour, r = data && data.rulings;

  if (which === 'agents' && a) {
    const parts = [['build', 'Building', a.time.build], ['review', 'Reviewing', a.time.review], ['idle', 'Idle', a.time.idle]];
    const total = parts.reduce((sum, p) => sum + (p[2] || 0), 0);
    let offset = 0;
    const bar = '<svg class="np-split" viewBox="0 0 1000 10" preserveAspectRatio="none" role="img" aria-label="Agent time: building, reviewing and idle"><rect class="np-track" width="1000" height="10" rx="5"/>' + parts.map(p => {
      const width = total ? (p[2] || 0) / total * 1000 : 0, rect = '<rect class="np-' + p[0] + '" x="' + offset.toFixed(1) + '" width="' + width.toFixed(1) + '" height="10"/>';
      offset += width; return rect;
    }).join('') + '</svg>';
    const key = '<div class="np-key">' + parts.map(p => '<span class="np-k-' + p[0] + '">' + p[1] + ' <b>' + share(p[2] || 0, total) + '%</b></span>').join('') + '</div>';
    return head('Agents · ' + a.total + (a.measured === false ? ' · at work now' : ' · agent time, last 4 h')) + '<div class="np-viz">' + bar + key + '</div>' + a.rows.map(row).join('') + go(a.goLabel || 'Open Progress', a.go || 'tab:dashboard');
  }

  if (which === 'perHour' && h) {
    const bins = h.bins || [], peak = Math.max(1, ...bins);
    const spark = '<svg class="np-spark" viewBox="0 0 960 40" preserveAspectRatio="none" role="img" aria-label="Items landed per hour, last 24 hours">' + bins.map((n, i) => {
      const height = n ? Math.max(3, n / peak * 38) : 1;
      return '<rect class="' + (i === bins.length - 1 ? 'np-now' : n ? 'np-bin' : 'np-none') + '" x="' + (i * 40 + 4) + '" y="' + (40 - height) + '" width="32" height="' + height + '" rx="2"><title>' + n + ' landed</title></rect>';
    }).join('') + '</svg><div class="np-axis"><span>24 h ago</span><span>12 h</span><span>now</span></div>';
    return head('Pace · ' + h.rate + ' · landed per hour') + '<div class="np-viz">' + spark + '</div>' + h.rows.map(row).join('') + go(h.goLabel || 'Open Dashboard', h.go || 'tab:dashboard');
  }

  if ((which === 'rulings' || which === 'list') && r) {
    const items = r.items || [], count = items.length;
    const ruling = it => '<div class="np-d" data-ruling="' + esc(it.go || '') + '">' + icon(it.kind) + '<span class="np-tx"><b>' + esc(it.title) + '</b><small><em>' + esc(it.cls) + '</em> · ' + esc(it.thing) + '</small></span><button class="np-act" type="button" data-go="' + esc(it.go || '') + '">' + esc(it.action) + '</button></div>';
    if (which === 'list') return head('Rulings · ' + count) + (count ? items.map(ruling).join('') : '<p class="np-empty">No rulings.</p>');
    const kinds = [];
    for (const it of items) { const k = kinds.find(x => x.kind === it.kind); if (k) k.n++; else kinds.push({ kind: it.kind, label: it.cls, n: 1 }); }
    let offset = 0;
    const bar = '<svg class="np-split" viewBox="0 0 1000 10" preserveAspectRatio="none" role="img" aria-label="Rulings by kind">' + kinds.map(k => {
      const width = k.n / Math.max(1, count) * 1000, rect = '<rect class="np-f-' + esc(k.kind) + '" x="' + offset.toFixed(1) + '" width="' + Math.max(0, width - 2).toFixed(1) + '" height="10"/>';
      offset += width; return rect;
    }).join('') + '</svg>';
    const key = '<div class="np-key">' + kinds.map(k => '<span class="np-k-' + esc(k.kind) + '">' + esc(k.label) + ' <b>' + k.n + '</b></span>').join('') + '</div>';
    const rows = items.slice(0, 3).map(it => '<div class="np-d">' + icon(it.kind) + '<span class="np-tx"><b>' + esc(it.title) + '</b><small><em>' + esc(it.cls) + '</em> · ' + esc(it.thing) + '</small></span><span class="np-act">' + esc(it.action) + '</span></div>').join('');
    return head('Rulings · ' + count + (r.oldest ? ' · oldest waiting ' + r.oldest : '')) + '<div class="np-viz">' + bar + key + '</div>' + rows + '<button class="np-go" type="button" data-notch-list>Open all ' + count + ' ›</button>';
  }
  return '';
}

/**
 * The notch's three previews from the numbers the page already computed (agentFloorModel's output) and its prepared
 * rulings; nothing is fetched.
 *
 * @param {{ floor: object, rulings?: object[], oldest?: string }} input - floor is agentFloorModel's result;
 *   rulings are { kind, title, cls, thing, action, go }.
 * @returns {{ agents: object, perHour: object, rulings: object }}
 */
export function notchPreviewData({ floor, rulings = [], oldest = '' }) {
  const n = floor.numbers, bins = floor.bins.map(bin => bin.count);
  const rate = hours => { const last = bins.slice(-hours); return last.length ? Math.round(last.reduce((s, c) => s + c, 0) / last.length) : 0; };
  // The board's own pace (what the notch shows) wins over bars rebuilt from a partial history.
  const pace = n.pace, six = pace ? Math.round(pace.last6h / 6) : rate(6), two = pace ? Math.round(pace.last2h / 2) : rate(2);
  return {
    agents: { total: n.live, measured: floor.complete !== false, time: floor.complete === false ? { build: n.building, review: n.reviewing, idle: n.between } : floor.time, go: 'tab:dashboard', goLabel: 'Open Progress', rows: [
      { kind: 'build', title: 'Building items', label: 'Builders', note: 'at work now', value: n.building },
      { kind: 'review', title: 'Reviewing submissions', label: 'Reviewers', note: 'checking another agent\'s work', value: n.reviewing },
      { kind: 'idle', title: 'Finding the next item', label: 'Idle', note: 'picking the next', value: n.between },
    ] },
    perHour: { rate: six + '/h', bins, go: 'tab:dashboard', goLabel: 'Open Dashboard', rows: [
      { kind: 'pace', title: 'Last 6 hours', label: 'Pace', note: 'today\'s rate', value: six + '/h', tone: 'g' },
      { kind: 'pace', title: 'Last 2 hours', label: 'Pace', note: two < six ? 'slowing' : 'holding', value: two + '/h', tone: two < six ? 'a' : 'g' },
      { kind: 'land', title: 'Landed in 24 hours', label: 'Landed', note: 'on main', value: pace ? pace.last24h : n.landed ?? '—' },
      { kind: 'back', title: 'Sent back in 4 hours', label: 'Rework', note: 'to their builders', value: n.sentBack ?? '—', tone: 'r' },
    ] },
    rulings: { items: rulings, oldest },
  };
}

/**
 * The notch's floor numbers from a Dashboard model alone: agents by state, agent time, landed per hour. It is agentFloorModel's
 * headline without its event sort, which costs hundreds of milliseconds on a big board, so a hover answers at once.
 *
 * @param {object} state - What dashboardModel returned.
 * @param {number} live - The notch's own agents number, so the preview's header agrees with it.
 * @param {object|null} pace - The board's last2h, last6h and last24h landed counts, so the pace agrees with the notch.
 * @returns {{ numbers: object, time: object, bins: object[] }} The shape notchPreviewData reads.
 */
export function notchFloor(state, live, pace = null) {
  const window = state.now - state.start, work = state.agents.filter(agent => agent.group !== 'quiet');
  const count = key => state.agents.filter(agent => agent.group === key).length;
  const sum = key => work.reduce((total, agent) => total + Math.min(window, agent[key] || 0), 0);
  // Idle is each working agent's share of the window that was neither building nor reviewing, never the model's open-ended idle.
  const idle = work.reduce((total, agent) => total + Math.max(0, window - Math.min(window, agent.build || 0) - Math.min(window, agent.review || 0)), 0);
  return { complete: state.complete, numbers: { live, building: count('building'), reviewing: count('reviewing'), between: count('between items'), landed: state.totals.day, sentBack: state.totals.sentBack, pace },
    time: { build: sum('build'), review: sum('review'), idle }, bins: state.bins };
}

/**
 * The person's calls (the page's personNeeds rows) as the rulings list the notch previews: a plain title, its kind, what it
 * is about, the button's words and where the button goes. Reading it never touches the board.
 *
 * @param {object[]} calls - personNeeds rows.
 * @param {(row: object) => object} words - The page's plainNeedWords, which keeps codes and commands out of the words.
 * @param {(iso: string) => string} age - The page's age words, for the oldest call.
 * @returns {{ items: object[], oldest: string }}
 */
export function notchRulings(calls, words, age) {
  const kinds = { draft: ['spec', 'Draft rows'], decision: ['item', 'Decision'], pending: ['spec', 'Spec question'], 'spec-revision': ['spec', 'Spec change'], 'agent-approved': ['spec', 'Confirm a row'],
    'focus-approval-batch': ['spec', 'Release rows'], hold: ['ship', 'Held lane'], 'rigor-draft': ['rigor', 'Rigor'], 'sentinel-draft': ['rigor', 'Sentinel'], block: ['data', 'Blocked'], 'relay-health': ['data', 'Relay'] };
  const rows = calls.map(row => row.kind === 'draft' ? { kind: 'draft', id: 'drafts', ref: 'Spec', text: row.count + ' draft rows', target: 'tab:spec' } : words(row));
  const items = rows.map(row => {
    const [kind, cls] = kinds[row.kind] || ['item', 'Ruling'];
    const go = row.kind === 'decision' ? 'decide:' + row.id : row.kind === 'pending' ? 'spec:' + row.id : row.kind === 'hold' ? 'tab:shouts' : row.target || 'tab:items';
    const title = String(row.text || row.ref || cls).split(/\n/u)[0].replace(/\s+/gu, ' ').trim();
    return { kind, cls, title: title.length > 88 ? title.slice(0, 87) + '…' : title, thing: String(row.ref || row.id || ''), action: row.kind === 'decision' ? 'Decide' : row.kind === 'agent-approved' ? 'Confirm' : 'Review', go, at: Date.parse(row.at || row.approvedAt) || null };
  });
  const first = items.filter(item => item.at).sort((a, b) => a.at - b.at)[0];
  return { items, oldest: first ? age(new Date(first.at).toISOString()) : '' };
}

/**
 * Wire a notch to its panel. Hovering a widget (a descendant carrying data-notch="agents|perHour|rulings") opens
 * the panel after `delay` ms, sliding down over a blurred page; leaving closes it `grace` ms later; moving between
 * widgets switches at once. Clicking rulings, or the preview's "Open all", opens the full list in the same panel,
 * which Esc, a click outside, or choosing an action closes. A click on another widget closes the preview so the
 * page's own data-go dispatch opens that page. The panel is built from `read()` each time, so it always shows the
 * board state the page holds now.
 *
 * @param {Element} notch - The notch element.
 * @param {() => object} read - Returns the data for notchPreviewHtml.
 * @param {object} [options] - html (renderer), delay, grace, setTimer, clearTimer (for tests).
 * @returns {{ show: Function, list: Function, close: Function, state: Function, destroy: Function }}
 */
export function notchPreview(notch, read, { html = notchPreviewHtml, delay = 160, grace = 180, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const doc = notch.ownerDocument, root = doc.body;
  const veil = doc.createElement('div'), panel = doc.createElement('div');
  veil.className = 'notch-veil'; panel.className = 'notch-panel';
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Notch preview');
  root.append(veil, panel);
  let open = null, mode = null, timer = null, trigger = null;
  const widget = target => {
    const button = target && target.closest ? target.closest('[data-peek]') : null;
    return (button && button.querySelector('[data-notch]')) || (target && target.closest ? target.closest('[data-notch]') : null);
  };
  const inside = target => Boolean(target && (panel.contains(target) || (notch.contains(target) && widget(target))));
  const place = () => {
    const box = notch.getBoundingClientRect && notch.getBoundingClientRect();
    // The page's one runtime stylesheet carries the notch's bottom edge; no element is styled inline.
    if (box && typeof geometry === 'function') { panel.setAttribute('data-geo', 'notch-panel'); veil.setAttribute('data-geo', 'notch-panel'); geometry('notch-panel', { '--notch-bottom': Math.round(box.bottom) + 'px' }); }
  };
  const paint = () => {
    const on = open !== null;
    panel.setAttribute('data-open', String(on)); veil.setAttribute('data-open', String(on));
    root.setAttribute('data-notch-open', on ? mode : 'false');
    for (const el of notch.querySelectorAll('[data-notch]')) el.setAttribute('aria-expanded', String(el === trigger));
  };
  const show = (el, as = 'preview') => {
    const which = el.getAttribute('data-notch');
    const markup = html(read(), as === 'list' ? 'list' : which);
    if (!markup) return;
    place();
    open = which; mode = as; trigger = el;
    panel.innerHTML = markup;
    paint();
  };
  const close = () => { clearTimer(timer); timer = null; open = null; mode = null; trigger = null; paint(); };
  const onOver = event => {
    const el = widget(event.target);
    if (!el || !notch.contains(el) || mode === 'list') return;
    clearTimer(timer);
    if (el === trigger) return;
    timer = setTimer(() => show(el), open ? 0 : delay);
  };
  const onLeave = event => {
    if (mode === 'list') return;
    if (inside(event.relatedTarget)) return;
    clearTimer(timer); timer = setTimer(close, grace);
  };
  const onClick = event => {
    const el = widget(event.target);
    if (el && notch.contains(el)) {
      if (el.getAttribute('data-notch') === 'rulings') { event.stopPropagation?.(); clearTimer(timer); show(el, 'list'); } else close();
    }
  };
  const onPanelClick = event => {
    if (event.target.closest('[data-notch-list]')) { show(trigger || notch.querySelector('[data-notch="rulings"]'), 'list'); return; }
    if (event.target.closest('[data-go]')) close();
  };
  const onKey = event => { if (event.key === 'Escape' && open !== null) close(); };
  const onPanelOver = () => { if (mode !== 'list') clearTimer(timer); };
  notch.addEventListener('mouseover', onOver); notch.addEventListener('mouseout', onLeave);
  notch.addEventListener('click', onClick);
  panel.addEventListener('mouseover', onPanelOver); panel.addEventListener('mouseout', onLeave);
  panel.addEventListener('click', onPanelClick);
  veil.addEventListener('click', close);
  doc.addEventListener('keydown', onKey);
  paint();
  return {
    show: (which, as) => { const el = notch.querySelector('[data-notch="' + which + '"]'); if (el) show(el, as); },
    list: () => { const el = notch.querySelector('[data-notch="rulings"]'); if (el) show(el, 'list'); },
    close, state: () => ({ open, mode }),
    destroy: () => {
      close(); notch.removeEventListener('mouseover', onOver); notch.removeEventListener('mouseout', onLeave);
      notch.removeEventListener('click', onClick); doc.removeEventListener('keydown', onKey); veil.remove(); panel.remove();
    },
  };
}
