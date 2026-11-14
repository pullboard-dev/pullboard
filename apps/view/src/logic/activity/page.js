/**
 * The Activity page markup (approved mockup activity-approved-1113, #6916), drawn from the flow model and the page's
 * UI state: Since you left, Bottlenecks, By hour (header, two-line key, one card per hour with its waterfall and one
 * slot that holds an Events tab and, after a bar click, an Item tab), the Agents, Runners, Queue and Main rail and the
 * four-cell Resources band under it. The view's policy refuses inline styles, so every proportion is SVG geometry [N26].
 * The page embeds this function's source text, so it reads only its arguments and language globals.
 *
 * @param {object} flow - The activityFlow model.
 * @param {object} ui - { filter, lane: {stage, sub}|null, page, open: hour start|null, tab: 'ev'|'item', item, itemHour, pages: {hour start: n}, evBefore }.
 * @param {object} [options]
 * @param {number} [options.width] - The hour cards' inner width in px, for the SVG bands.
 * @param {boolean} [options.leftKnown] - Whether the person's last look is a remembered time.
 * @param {number} [options.newer] - How many events arrived since the page was drawn.
 * @param {string} [options.controls] - The filter strip's markup, shown inside the page on a narrow screen.
 * @param {Function} [options.itemHref] - The address of an item; a quoted #N links to it [N38].
 * @param {boolean} [options.narrow] - A phone-width layout.
 * @returns {string} The page's markup.
 */
export function activityPageHtml(flow, ui, { width = 740, leftKnown = true, newer = 0, controls = '', narrow = false, itemHref = id => '/items/' + id } = {}) {
  const esc = value => String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const MIN = 60_000, HOUR = 3_600_000, PER = 3, PAGE_ROWS = 10, BLEED = 22;
  const now = flow.now, names = flow.names;
  const clock = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const clockShort = ms => clock(ms).replace(/ (AM|PM)/u, '');
  const hourName = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric' });
  const dur = ms => { const m = Math.max(1, Math.round(ms / MIN)); return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm'; };
  const ago = ms => { const m = Math.max(0, Math.round((now - ms) / MIN)); return m < 60 ? m + 'm ago' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
  const KIND = { landed: ['l', 'Landed'], sentback: ['x', 'Sent back'], held: ['h', 'Held'], blocked: ['g', 'Blocked'], pending: ['r', 'Pending review'], ruling: ['ru', 'Ruling'],
    shout: ['g', 'Shout'], building: ['b', 'Building'], review: ['r', 'In review'], ready: ['rd', 'Ready'], withdrawn: ['x', 'Withdrawn'], sentinel: ['g', 'Sentinel'], gate: ['gt', 'Gate'], landing: ['l', 'Landing'] };
  const SEG = { ready: 'rd', build: 'b', blk: 'g', gate: 'gt', pend: 'r', rev: 'r', land: 'l', held: 'h' };
  const FILTERS = [['all', 'All'], ['landed', 'Landed'], ['sentback', 'Sent back'], ['held', 'Held'], ['blocked', 'Blocked'], ['pending', 'Pending review'], ['ruling', 'Rulings'], ['shout', 'Shouts']];
  const STAGE_COLOR = { ready: 'ready', building: 'building', gate: 'gate', pending: 'review', landing: 'merged' };
  const filter = ui.filter || 'all', lane = ui.lane || null;
  const laneItems = lane ? flow.laneIds(lane.stage, lane.sub) : null;
  const filtered = filter !== 'all' || Boolean(lane);
  const stageName = key => (flow.bottlenecks.find(row => row.key === key)?.name ?? key).toLowerCase();
  const labelOf = kind => (FILTERS.find(([key]) => key === kind)?.[1] ?? kind).toLowerCase();
  const match = entry => lane ? laneItems.has(entry.id) : filter === 'all' || entry.kind === filter;
  const chip = (kind, label) => '<span class="act-chip ' + kind + '">' + esc(label) + '</span>';
  const journey = id => flow.journeyById.get(id);

  // ---- the waterfall for one hour, with a faded slice of the hours either side ----
  const keepSet = (() => {
    if (ui.item) return new Set([ui.item]);
    if (laneItems) return laneItems;
    if (filter === 'all') return null;
    return new Set(flow.events.filter(entry => entry.kind === filter && entry.id !== null).map(entry => entry.id));
  })();
  const waterfall = (hour, big) => {
    const BLEED_MIN = 10, GUT = 54, X0 = 8, STILL = ['ready', 'blk', 'held'];
    const topMin = (hour.h1 + (hour.h1 < now ? BLEED_MIN * MIN : 0)) / MIN, botMin = (hour.from - BLEED_MIN * MIN) / MIN;
    // The current hour is drawn at least twice as tall as an older one, however few minutes of it have passed.
    const PPM = big ? Math.max(3, 220 / (topMin - botMin)) : 1.25, tall = Math.round((topMin - botMin) * PPM);
    const W = width, AREA = W - GUT - X0 - 6, y = ms => (topMin - ms / MIN) * PPM;
    const lowMs = botMin * MIN, highMs = topMin * MIN, lo = hour.from, hi = hour.h1;
    // Moved this hour: an item that changed (stage, landing, send-back, ruling, shout) or was at work inside the hour. Items that only waited are counted, not drawn.
    const firstChange = item => Math.min(item.drawStart >= lo && item.drawStart < hi ? item.drawStart : Infinity, ...item.segs.filter(seg => seg.a >= lo && seg.a < hi && seg.a > item.drawStart && !seg.over).map(seg => seg.a),
      item.landed && item.end >= lo && item.end < hi ? item.end : Infinity, ...item.marks.filter(mark => mark.t >= lo && mark.t < hi).map(mark => mark.t));
    const working = item => item.segs.some(seg => seg.b > Math.max(lo, item.drawStart) && seg.a < hi && !STILL.includes(seg.k));
    const inHour = [...flow.journeyById.values()].filter(item => item.end >= lo && item.drawStart < hi);
    const moved = inHour.filter(item => firstChange(item) < Infinity || working(item)), still = inHour.filter(item => !moved.includes(item));
    const order = new Map(moved.map(item => [item, Math.min(firstChange(item), Math.max(item.drawStart, lo))]));
    const CAP = 60;
    const sorted = moved.filter(item => item.segs.some(seg => !STILL.includes(seg.k)) || firstChange(item) < Infinity).sort((a, b) => order.get(a) - order.get(b) || a.id - b.id);
    const more = Math.max(0, sorted.length - CAP), list = sorted.slice(0, CAP);
    // Columns: the first one free for three minutes, so the hour fills the card's width.
    const ends = [], lane = new Map();
    for (const item of list) {
      const from = Math.max(item.drawStart, lowMs), to = Math.min(item.end, highMs);
      let at = ends.findIndex(end => end <= from);
      if (at < 0) { at = ends.length; ends.push(0); }
      ends[at] = to + 3 * MIN; lane.set(item.id, at);
    }
    const cols = Math.max(ends.length, 1), pitch = Math.min(28, AREA / cols), bw = Math.max(2, Math.min(12, Math.round(pitch * 0.6)));
    let s = '<svg class="act-wfsvg" viewBox="0 0 ' + W + ' ' + tall + '" width="' + W + '" height="' + tall + '" shape-rendering="crispEdges" role="img" aria-label="' + esc(hourName(hour.h0)) + ' waterfall">';
    for (let q = 15; q < 60; q += 15) { const at = hour.h0 + q * MIN; if (at < hour.h1) s += '<line class="act-grid" x1="0" x2="' + (W - GUT) + '" y1="' + y(at) + '" y2="' + y(at) + '"/>'; }
    const left = leftKnown ? flow.since.at : null;
    if (left !== null && left >= hour.from && left < hour.h1) s += '<line class="act-lleft" x1="0" x2="' + (W - GUT) + '" y1="' + y(left) + '" y2="' + y(left) + '"/>';
    for (const item of list) {
      const x = X0 + lane.get(item.id) * pitch + (pitch - bw) / 2, dim = keepSet && !keepSet.has(item.id);
      let g = '<g data-id="' + item.id + '"' + (dim ? ' class="dim"' : '') + '><rect class="act-hit" x="' + (x - (pitch - bw) / 2) + '" y="' + y(Math.min(item.end, highMs)) + '" width="' + pitch + '" height="' + Math.max(0, y(Math.max(item.drawStart, lowMs)) - y(Math.min(item.end, highMs))) + '"/>';
      for (const seg of item.segs) {
        const a0 = Math.max(seg.a, item.drawStart, lowMs), b0 = Math.min(seg.b, highMs);
        if (b0 <= a0) continue;
        // Neighbour minutes are faint; a stay carried in from before the hour is pale; what starts in the hour is full colour.
        for (const [a, b, tone] of [[a0, Math.min(b0, lo), ' nb'], [Math.max(a0, lo), Math.min(b0, hi), seg.a < lo ? ' mut' : ''], [Math.max(a0, hi), b0, ' nb']]) {
          if (b > a) g += '<rect class="s-' + seg.k + tone + '" x="' + x + '" y="' + y(b) + '" width="' + bw + '" height="' + Math.max(0.8, (b - a) / MIN * PPM - 0.4) + '"/>';
        }
        // Past limit is a thin red cap where the board's limit was crossed: the excess segment begins there.
        if (seg.over && seg.a >= Math.max(lo, lowMs) && seg.a < hi) g += '<rect class="m-cap" x="' + (x - 1) + '" y="' + (y(seg.a) - 1.2) + '" width="' + (bw + 2) + '" height="2.4"/>';
      }
      for (const mark of item.marks) {
        if (mark.t < lo || mark.t >= hi) continue;
        const cy = y(mark.t), cx = x + bw / 2;
        if (mark.k === 'back') g += '<rect class="m-back" x="' + (x - 2) + '" y="' + (cy - 1) + '" width="' + (bw + 4) + '" height="2.2"/>';
        else g += '<circle class="m-' + (mark.k === 'ruling' ? 'rul' : 'sh') + '" cx="' + cx + '" cy="' + cy + '" r="' + Math.max(2.4, bw / 2 + 0.6) + '" shape-rendering="auto"/>';
      }
      if (item.landed && item.end >= lo && item.end < hi) g += '<rect class="m-land" x="' + (x - 1) + '" y="' + (y(item.end) - 3) + '" width="' + (bw + 2) + '" height="3"/>';
      s += g + '</g>';
    }
    // Light neighbour edges: a dashed hour line with its label in the right gutter, never on the bars.
    if (highMs > hour.h1) s += '<line class="act-edge" x1="0" x2="' + W + '" y1="' + y(hour.h1) + '" y2="' + y(hour.h1) + '"/><text class="act-bleed" x="' + (W - 6) + '" y="' + (y(hour.h1) - 4) + '" text-anchor="end">' + esc(hourName(hour.h1)) + ' ↑</text>';
    s += '<line class="act-edge" x1="0" x2="' + W + '" y1="' + y(hour.from) + '" y2="' + y(hour.from) + '"/><text class="act-bleed" x="' + (W - 6) + '" y="' + (y(hour.from) + 11) + '" text-anchor="end">' + esc(hourName(hour.from - HOUR)) + ' ↓</text>';
    if (hour.h1 === now) s += '<line class="act-lnow" x1="0" x2="' + W + '" y1="0.5" y2="0.5"/><text class="act-tick now" x="' + (W - 6) + '" y="13" text-anchor="end">now</text>';
    // Labels are SVG text, so no element needs a style attribute.
    for (const q of [15, 30, 45]) { const at = hour.h0 + q * MIN; if (at < hour.h1 - 4 * MIN && !(hour.h1 === now && y(at) < 26) && !(left !== null && Math.abs(at - left) <= 7 * MIN)) s += '<text class="act-tick" x="' + (W - 6) + '" y="' + (y(at) + 3.5) + '" text-anchor="end">:' + q + '</text>'; }
    if (left !== null && left >= hour.from && left < hour.h1) s += '<text class="act-tick" x="' + (W - 6) + '" y="' + (y(left) + 3.5) + '" text-anchor="end">you left</text>';
    s += '</svg>';
    const by = { ready: 0, blk: 0, held: 0, other: 0 };
    for (const item of still) { const seg = item.segs.findLast(seg => seg.a < hour.h1) ?? item.segs.at(-1); by[seg && seg.k in by ? seg.k : 'other']++; }
    const parts = [['ready', 'ready'], ['blk', 'blocked'], ['held', 'held'], ['other', 'other']].filter(([k]) => by[k]).map(([k, word]) => by[k] + ' ' + word);
    const note = [more ? 'and ' + more + ' more moved' : '', still.length ? still.length + ' only waited all hour, counted in Bottlenecks: ' + parts.join(' · ') : ''].filter(Boolean).join(' · ');
    return s + (note ? '<p class="act-wfnote">' + esc(note) + '</p>' : '');
  };

  // ---- event rows ----
  /** A quote with every cited #N linked to that item, the rest escaped [N38]. */
  const quoted = text => '“' + String(text ?? '').split(/(#\d+)/u).map(part => /^#\d+$/u.test(part) ? '<a class="ref" href="' + esc(itemHref(part.slice(1))) + '" data-go="item:' + part.slice(1) + '">' + part + '</a>' : esc(part)).join('') + '”';
  const rowHtml = (entry, withTitle) => {
    const [cls, label] = KIND[entry.kind] ?? ['g', entry.kind];
    const line1 = withTitle ? (entry.id !== null ? '<span class="id">#' + entry.id + '</span>' : '') + (entry.quote ? quoted(entry.quote) : esc(entry.title || (entry.kind === 'ruling' ? 'A ruling for you' : entry.id !== null ? 'This item' : 'A message')))
      : entry.quote ? quoted(entry.quote) : entry.kind === 'landed' ? 'on main' : esc(entry.fact.split(' · ')[0]);
    const line2 = withTitle ? esc(entry.fact) : entry.quote ? esc(entry.fact) : entry.fact.includes(' · ') ? esc(entry.fact.split(' · ').slice(1).join(' · ')) : '';
    return '<div class="act-row' + (entry.id !== null ? ' has' : '') + '"' + (entry.id !== null ? ' data-row="' + entry.id + '"' : '') + '><span class="t">' + (withTitle ? ago(entry.at) : clockShort(entry.at)) + '</span>' + chip(cls, label) + '<span class="ph"' + (withTitle && entry.title ? ' title="' + esc(entry.title) + '"' : '') + '>' + line1 + '</span><span class="fa">' + line2 + '</span></div>';
  };
  const pager = (h0, page, total) => total > PAGE_ROWS ? '<div class="act-pager">' + (page > 1 ? '<a data-act-pg="' + h0 + '" data-to="' + (page - 1) + '">Previous</a>' : '')
    + (page * PAGE_ROWS < total ? '<a data-act-pg="' + h0 + '" data-to="' + (page + 1) + '">Next 10</a>' : '') + '<span>' + ((page - 1) * PAGE_ROWS + 1) + '–' + Math.min(page * PAGE_ROWS, total) + ' · ' + total + ' in this hour</span></div>' : '';
  const hourRows = (hour, matched) => {
    const page = Math.min(ui.pages?.[hour.h0] || 1, Math.max(1, Math.ceil(matched.length / PAGE_ROWS)));
    const slice = matched.slice((page - 1) * PAGE_ROWS, page * PAGE_ROWS), left = leftKnown ? flow.since.at : null;
    let html = '', divided = false;
    slice.forEach((entry, index) => {
      if (!divided && left !== null && index > 0 && entry.at < left && slice[index - 1].at >= left) { html += '<div class="act-left"><span>since you left · ' + clock(left) + '</span></div>'; divided = true; }
      html += rowHtml(entry, true);
    });
    return '<div class="act-evrows">' + html + pager(hour.h0, page, matched.length) + '</div>';
  };

  // ---- one item's journey: where it sits in the page's hours, then its bar with stage durations and past-limit time ----
  const itemPanel = (item, range) => {
    const Wc = Math.max(200, width - 28), minW = narrow ? 22 : 8;
    const span = Math.max(1, item.end - item.start), pct = ms => (ms - item.start) / span * Wc;
    const merged = [];
    for (const seg of item.segs) { const last = merged.at(-1); if (seg.over && last && last.k === seg.k) { last.over = seg.b - seg.a; last.b = seg.b; } else merged.push({ k: seg.k, a: seg.a, b: seg.b, over: seg.over ? seg.b - seg.a : 0 }); }
    const [C0, C1] = range, cp = ms => (Math.max(Math.min(ms, C1), C0) - C0) / Math.max(1, C1 - C0) * Wc;
    const L = cp(item.start), R = cp(item.end);
    let s = '<svg class="act-jsvg" viewBox="0 0 ' + Wc + ' 124" width="' + Wc + '" height="124" role="img" aria-label="Journey of #' + item.id + '">';
    s += '<rect class="j-track" x="0" y="0" width="' + Wc + '" height="6"/>';
    for (const seg of item.segs) if (seg.b > C0) s += '<rect class="s-' + seg.k + '" x="' + cp(seg.a) + '" y="0" width="' + Math.max(1, cp(seg.b) - cp(seg.a)) + '" height="6"/>';
    s += '<rect class="j-box" x="' + L + '" y="-3" width="' + Math.max(3, R - L) + '" height="12" rx="2"/>';
    for (let h = Math.ceil(C0 / HOUR) * HOUR; h <= C1 - 10 * MIN; h += HOUR) s += '<text class="j-hr" x="' + cp(h) + '" y="21" text-anchor="middle">' + esc(hourName(h)) + '</text>';
    if (C1 === now) s += '<text class="j-hr now" x="' + Wc + '" y="21" text-anchor="end">now</text>';
    s += '<path class="j-wedge" d="M' + L + ' 26 L' + R + ' 26 L' + Wc + ' 42 L0 42 Z"/><path class="j-wline" d="M' + L + ' 26 L0 42 M' + R + ' 26 L' + Wc + ' 42"/>';
    for (const seg of merged) s += '<rect class="s-' + seg.k + '" x="' + pct(seg.a) + '" y="46" width="' + Math.max(1, pct(seg.b) - pct(seg.a)) + '" height="20"/>'
      + (seg.over ? '<rect class="s-over" x="' + pct(seg.b - seg.over) + '" y="46" width="' + Math.max(1, pct(seg.b) - pct(seg.b - seg.over)) + '" height="20"/>' : '') + '<line class="j-cut" x1="' + pct(seg.b) + '" x2="' + pct(seg.b) + '" y1="46" y2="66"/>';
    for (const mark of item.marks) {
      if (mark.k === 'back') s += '<rect class="m-back" x="' + (pct(mark.t) - 1) + '" y="42" width="2" height="28"/>';
      else s += '<circle class="m-' + (mark.k === 'ruling' ? 'rul' : 'sh') + '" cx="' + pct(mark.t) + '" cy="56" r="' + (mark.k === 'ruling' ? 4 : 3) + '"/>';
    }
    for (const seg of merged) {
      const w = pct(seg.b) - pct(seg.a);
      if (w < minW * Wc / 100) continue;
      const fit = text => text.length * 6.3 > w - 6 ? text.slice(0, Math.max(0, Math.floor((w - 6) / 6.3) - 1)) + '…' : text;
      s += '<text class="j-l1" x="' + (pct(seg.a) + 1) + '" y="80">' + esc(fit(names[seg.k])) + '</text><text class="j-l2" x="' + (pct(seg.a) + 1) + '" y="94">' + esc(fit(dur(seg.b - seg.a)))
        + (seg.over && w > 140 ? '<tspan class="j-over" dx="6">' + esc(dur(seg.over)) + ' past limit</tspan>' : '') + '</text>';
    }
    s += '<line class="j-rule" x1="0" x2="' + Wc + '" y1="104" y2="104"/><text class="j-tk" x="0" y="118">' + clock(item.start) + '</text><text class="j-tk" x="' + Wc + '" y="118" text-anchor="end">' + (item.landed ? clock(item.end) : 'now') + '</text>';
    const step = ([15, 30, 60, 120, 180, 360, 720, 1440].find(minutes => span / (minutes * MIN) <= (narrow ? 4 : 7)) ?? 1440) * MIN, edge = (narrow ? 14 : 7) / 100 * Wc;
    for (let t = Math.ceil(item.start / step) * step; t < item.end; t += step) if (pct(t) > edge * 2.2 && pct(t) < Wc - edge * 2.2 && (!narrow || (t / step) % 1 === 0)) s += '<text class="j-tk mid" x="' + pct(t) + '" y="118" text-anchor="middle">' + clockShort(t) + '</text>';
    s += '</svg>';
    const mine = flow.events.filter(entry => entry.id === item.id);
    return '<div class="act-ip">' + s + '<div class="act-ipe">' + mine.slice(0, PAGE_ROWS).map(entry => rowHtml(entry, false)).join('')
      + (mine.length > PAGE_ROWS ? '<div class="act-pager"><span>first 10 of ' + mine.length + ' · </span><a data-go="item:' + item.id + '">All in Items ›</a></div>' : '') + '</div></div>';
  };

  // ---- the hours ----
  const pagesTotal = Math.max(1, Math.ceil(flow.hours.length / PER)), page = Math.max(0, Math.min(ui.page || 0, pagesTotal - 1));
  const slice = flow.hours.slice(page * PER, (page + 1) * PER);
  const context = [slice.at(-1).from - BLEED * MIN, page ? slice[0].h1 + BLEED * MIN : now];
  const openItem = ui.item ? journey(ui.item) : null;
  const hourSections = slice.map(hour => {
    const big = hour.h1 === now && hour.h0 === flow.hours[0].h0;
    const matched = hour.events.filter(match), on = ui.open === hour.h0;
    const hasItem = Boolean(openItem) && ui.itemHour === hour.h0, showItem = on && hasItem && ui.tab === 'item', showEv = on && !showItem;
    const what = filtered ? (lane ? 'events' : labelOf(filter)) : 'events';
    const summary = !filtered ? '<span class="evc"><b>' + hour.events.length + '</b> events · </span><b>' + hour.landed + '</b> landed' + (hour.sentBack ? ' · <b>' + hour.sentBack + '</b> sent back' : '') + ' · peak <b>' + hour.peak + '</b><span class="w"> in flight</span>' + (hour.rulings ? ' · <span class="am">' + hour.rulings + ' ruling' + (hour.rulings > 1 ? 's' : '') + '</span>' : '')
      : lane ? '<b>' + matched.length + '</b> on ' + laneItems.size + ' ' + stageName(lane.stage) + ' items, ' + (lane.sub === 's' ? 'stuck' : 'working') : '<b>' + matched.length + '</b> ' + labelOf(filter);
    const evTab = '<button type="button" class="tb' + (showEv ? ' on' : '') + '" data-act-tab="ev" data-hour="' + hour.h0 + '" aria-expanded="' + (on && !showItem) + '"><span class="chv">›</span>' + (matched.length ? matched.length + ' ' + what : 'no ' + what)
      + (hasItem && on ? '' : '<span class="f">' + (matched.length ? ' · newest ' + ago(matched[0].at) : ' this hour') + '</span>') + '</button>';
    let tabs = '<div class="act-evt tabs' + (on ? ' open' : '') + '">' + evTab;
    if (on && hasItem) {
      const state = openItem.landed ? ['l', 'Landed'] : [SEG[openItem.state] ?? 'g', names[openItem.state] ?? ''];
      tabs += '<span class="tsep"></span><button type="button" class="tb it' + (showItem ? ' on' : '') + '" data-act-tab="item"><span class="id">#' + openItem.id + '</span><span class="tt">' + esc(openItem.title) + '</span>' + chip(state[0], state[1]) + '</button>'
        + '<button type="button" class="xb" data-act-close title="Close the item (Esc)" aria-label="Close the item">×</button>'
        + (showItem ? '<span class="tm">' + clock(openItem.start) + ' → ' + (openItem.landed ? clock(openItem.end) : 'now') + ' · ' + dur(openItem.end - openItem.start) + '</span>' : '');
    }
    tabs += '</div>';
    const slot = showItem ? itemPanel(openItem, context) : showEv ? (matched.length ? hourRows(hour, matched) : '<p class="act-none">No ' + esc(what) + ' in this hour.</p>') : '';
    return '<section class="act-sec act-hoursec" data-hour="' + hour.h0 + '"><div class="act-shd" data-act-hour="' + hour.h0 + '"><p class="act-h2">' + esc(hourName(hour.h0)) + (big ? '<span class="nowt">now</span>' : '') + '</p><span class="act-cap">' + summary + '</span></div>'
      + '<div class="act-card act-hourcard"><div class="act-wf" data-wf="' + hour.h0 + '">' + waterfall(hour, big) + '</div>' + tabs + slot + '</div></section>';
  }).join('');

  /** A proportional bar as SVG: parts are [share, class, attributes] drawn left to right over a 100-wide box. */
  const bars = (cls, parts, height = 1) => {
    const total = parts.reduce((sum, part) => sum + part[0], 0) || 1;
    let x = 0;
    return '<svg class="' + cls + '" viewBox="0 0 100 ' + height + '" preserveAspectRatio="none" aria-hidden="true">' + parts.map(([share, rect, wrap]) => {
      const w = share / total * 100, out = (wrap ? '<a ' + wrap + '>' : '') + '<rect class="' + rect + '" x="' + x + '" width="' + w + '" height="' + height + '"/>' + (wrap ? '</a>' : '');
      x += w; return out;
    }).join('') + '</svg>';
  };

  // ---- Since you left, Bottlenecks ----
  const s = flow.since, minutesLeft = s.at === null ? null : Math.max(1, Math.round((now - s.at) / MIN));
  const sinceHtml = '<p class="act-since">' + (leftKnown && s.at !== null ? 'Since you left ' + dur(now - s.at) + ' ago: ' : 'In the last hour: ')
    + '<a data-act-go="landed">' + s.landed + ' landed</a> · <a data-act-go="sentback">' + s.sentBack + ' sent back</a> · <a class="amb" data-act-go="ruling" title="Rulings raised in this window, not the top bar count">' + s.rulings + (s.rulings === 1 ? ' ruling' : ' rulings') + '</a>'
    + (newer > 0 ? '<a class="newer" data-act-new>' + newer + ' new ↑</a>' : '') + '</p>';
  void minutesLeft;
  const bottlenecks = '<section class="act-sec act-first"><div class="act-shd"><p class="act-lbl">Bottlenecks · now</p><span class="act-cap">'
    + (flow.off.blocked + flow.off.held ? 'Off the line: <a data-act-go="blocked">' + flow.off.blocked + ' blocked</a> · <a data-act-go="held">' + flow.off.held + ' held</a>' : '') + '</span></div>'
    + '<div class="act-card act-bn">' + flow.bottlenecks.map(row => {
      const total = Math.max(1, row.working + row.stuck);
      return '<div class="ln"><div class="nm"><i class="dot ' + STAGE_COLOR[row.key] + '"></i>' + esc(row.name) + (row.bottleneck ? '<span class="act-chip x">bottleneck</span>' : '') + '</div>'
        + '<div class="lb"><b>' + row.working + '</b> working → <b class="' + (row.stuck ? 'st' : 'none') + '">' + row.stuck + '</b> stuck</div>'
        + bars('gb', [[Math.max(row.working, 0.2), 'w ' + STAGE_COLOR[row.key], 'data-act-lane="' + row.key + '" data-sub="w"'], ...(row.stuck ? [[row.stuck, row.red ? 'sr' : 'sg', 'data-act-lane="' + row.key + '" data-sub="s"']] : [])], 1)
        + '<div class="od">' + (row.oldest === null ? 'empty' : 'oldest ' + dur(row.oldest)) + '</div></div>' + (total ? '' : '');
    }).join('') + '</div></section>';

  // ---- Resources: the rail, and the four-cell band for narrow screens ----
  const R = flow.rail, A = R.agents, hot = R.runners.filter(runner => runner.cpu !== null && runner.cpu >= 90).length, jobs = R.runners.reduce((sum, runner) => sum + runner.jobs, 0);
  const meanCpu = R.runners.length ? Math.round(R.runners.reduce((sum, runner) => sum + (runner.cpu ?? 0), 0) / R.runners.length) : 0;
  const splitBar = () => bars('split', [[A.building, 'b'], [A.reviewing, 'r'], [A.idle, 'i']]);
  const maxQueue = Math.max(1, ...R.queue.map(row => row.count));
  const sec = (head, body, margin = true) => '<section class="act-sec' + (margin ? '' : ' act-first') + '">' + head + body + '</section>';
  const cards = [
    '<div class="act-card rc">' + splitBar() + '<div class="keyrow"><span><i class="sw b"></i><b>' + A.building + '</b> building</span><span><i class="sw r"></i><b>' + A.reviewing + '</b> reviewing</span><span><i class="sw i"></i><b>' + A.idle + '</b> idle</span></div></div>',
    '<div class="act-card rc flush"><table class="rt"><tbody>' + (R.runners.length ? R.runners.map(runner => '<tr><td class="rn">' + esc(runner.name) + '</td><td class="rb">' + bars('load', [[runner.cpu ?? 0, runner.cpu >= 90 ? 'hot' : runner.cpu >= 70 ? 'hi' : 'lo'], [100 - (runner.cpu ?? 0), 'bg']]) + '</td><td class="n' + (runner.cpu >= 90 ? ' hot' : '') + '">' + (runner.cpu === null ? '—' : runner.cpu + '%') + '</td><td><span class="slots">'
      + Array.from({ length: Math.min(runner.jobs, 8) }, () => '<i></i>').join('') + '<em>' + runner.jobs + '</em></span></td></tr>').join('') : '<tr><td class="rn">No runner reports to this board.</td></tr>') + '</tbody></table></div>',
    '<div class="act-card rc flush">' + R.queue.map(row => '<div class="kv"><span>' + esc(row.name) + '</span>' + bars('load q', [[row.count, 'lo'], [maxQueue - row.count, 'bg']]) + '<b>' + row.count + '</b><small>' + (row.age === null ? '—' : row.word + ' ' + dur(row.age)) + '</small></div>').join('') + '</div>',
    '<div class="act-card rc main1"><span class="mdot' + (R.main.green ? '' : ' red') + '"></span><b class="' + (R.main.green ? '' : 'red') + '">' + (R.main.green ? 'Green' : 'Red') + '</b><span class="faint">' + (R.main.green ? (R.main.at ? 'for ' + dur(now - R.main.at) : '') : R.main.repairs + ' repair item' + (R.main.repairs === 1 ? '' : 's') + ' open') + '</span>' + (R.main.sha ? '<span class="commit">' + esc(R.main.sha.slice(0, 7)) + '</span>' : '') + '</div>',
  ];
  const rail = '<aside class="act-rail" aria-label="Resources">'
    + sec('<div class="act-shd"><p class="act-lbl">Agents<span class="act-pill" data-count="agents">' + A.total + '</span></p><button type="button" class="lk" data-tab="dashboard">Dashboard ›</button></div>', cards[0], false)
    + sec('<div class="act-shd"><p class="act-lbl">Runners<span class="act-pill" data-count="runners">' + (R.runnerCount ?? R.runners.length) + '</span></p><span class="act-cap">' + (hot ? '<b class="hotn">' + hot + '</b> hot · ' : '') + jobs + ' jobs</span></div>', cards[1])
    + sec('<div class="act-shd"><p class="act-lbl">Queue</p></div>', cards[2])
    + sec('<div class="act-shd"><p class="act-lbl">Main</p></div>', cards[3])
    + '</aside>';
  const openCell = ui.cell ?? null;
  const cell = (index, name, value) => '<button type="button" class="rcell' + (openCell === index ? ' on' : '') + '" data-act-res="' + index + '"><span class="rh"><span class="lbl2">' + name + '</span><span class="chv">›</span></span>' + value + '</button>';
  const resband = '<section class="act-sec act-resec"><div class="act-shd"><p class="act-lbl">Resources</p><span class="act-cap">tap a cell for its rows</span></div><div class="act-card resband">'
    + cell(0, 'Agents', '<span class="rv">' + splitBar() + '<span><b>' + A.building + '</b> building · <b>' + A.reviewing + '</b> reviewing<span class="wide"> · <b>' + A.idle + '</b> idle</span></span></span>')
    + cell(1, 'Runners', '<span class="rv">' + bars('load', [[meanCpu, meanCpu >= 90 ? 'hot' : meanCpu >= 70 ? 'hi' : 'lo'], [100 - meanCpu, 'bg']]) + '<span>' + (hot ? '<span class="hot">' + hot + '</span> hot · ' : '') + jobs + ' jobs</span></span>')
    + cell(2, 'Queue', '<span class="rv rvq"><span>' + R.queue.slice(0, 2).map(row => esc(row.name) + ' <b>' + row.count + '</b>').join(' · ') + '</span><span class="wide q2">' + esc(R.queue[2].name) + ' <b>' + R.queue[2].count + '</b></span></span>')
    + cell(3, 'Main', '<span class="rv"><span><span class="mdot' + (R.main.green ? '' : ' red') + '"></span><span class="' + (R.main.green ? 'g' : 'hot') + '">' + (R.main.green ? 'Green' : 'Red') + '</span>' + (R.main.at ? ' · ' + dur(now - R.main.at) : '') + (R.main.sha ? ' · <code>' + esc(R.main.sha.slice(0, 7)) + '</code>' : '') + '</span></span>')
    + (openCell === null ? '' : '<div class="resfull">' + cards[openCell].replace('class="act-card ', 'class="') + '</div>')
    + '</div></section>';

  // ---- By hour ----
  const first = slice.at(-1), last = slice[0];
  const hoursHead = '<div class="act-shd byh"><p class="act-lbl">By hour · ' + flow.windowHours + ' h</p><span class="act-cap">' + esc(hourName(first.h0)) + '–' + esc(hourName(last.h1 === now ? last.h0 + HOUR : last.h1)) + ' · ' + (page * PER + 1) + '–' + Math.min(flow.hours.length, (page + 1) * PER) + ' of ' + flow.hours.length + '</span></div>';
  const key = (cls, label, kind = 'sw') => '<span><i class="' + kind + ' ' + cls + '"></i>' + label + '</span>';
  const legend = '<div class="act-lg"><div>' + key('ready', 'Ready') + key('building', 'Building') + key('gate', 'Gate') + key('wait', 'Pending review') + key('review', 'In review') + key('landing', 'Landing') + '</div>'
    + '<div>' + key('blocked', 'Blocked') + key('held', 'Held') + key('cap', 'Past limit') + key('mute', 'Carried in, no change') + '<span class="x"></span>' + key('k-cap', 'Landed', '') + key('k-back', 'Sent back', '') + key('k-dot rul', 'Ruling', '') + key('k-dot sh', 'Shout', '') + '</div></div>';
  const end = '<p class="act-since end"><span>' + (page ? '<a class="pgn" data-act-page="-1">‹ Newer</a>' : '') + '</span>' + (page < pagesTotal - 1 ? '<a class="lkr" data-act-page="1">Earlier ' + PER + ' hours ›</a>' : '') + '</p>';
  const defs = '<svg class="act-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>'
    + '<pattern id="act-p-over" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="p-over" width="1.6" height="4"/></pattern>'
    + '<pattern id="act-p-land" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="p-landb" width="5" height="5"/><rect class="p-landa" width="2.5" height="5"/></pattern>'
    + '<pattern id="act-p-sg" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="p-sga" width="4" height="4"/><rect class="p-sgb" width="2" height="4"/></pattern>'
    + '<pattern id="act-p-sr" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="p-sra" width="4" height="4"/><rect class="p-srb" width="2" height="4"/></pattern>'
    + '<pattern id="act-p-held" width="6" height="6" patternUnits="userSpaceOnUse"><rect class="p-held" width="6" height="3.2"/></pattern></defs></svg>';
  const feed = '<div class="act-feedcol" aria-label="What happened, newest first">' + sinceHtml + bottlenecks + resband + '<div class="act-hours" id="act-hours">' + hoursHead + legend + hourSections + '</div>' + end + '</div>';
  // The zero-size pattern sprite comes last, so the page's first child is its own content, never a 0 x 0 box.
  return (controls ? '<div class="act-mfilters">' + controls + '</div>' : '') + '<div class="act-cols">' + feed + rail + '</div>' + defs;
}

/**
 * The hover card for one item's bar: its seat, stage chip, each stage's minutes with past-limit time, and its span.
 * The page embeds this function's source text, so it reads only its arguments and language globals [N26].
 *
 * @param {object} item - A journey of the flow model.
 * @param {object} flow - The activityFlow model.
 * @returns {string} The card's markup.
 */
export function activityTipHtml(item, flow) {
  const esc = value => String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const MIN = 60_000;
  const clock = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const SEG = { ready: 'rd', build: 'b', blk: 'g', gate: 'gt', pend: 'r', rev: 'r', land: 'l', held: 'h' };
  const state = item.landed ? ['l', 'Landed'] : [SEG[item.state] ?? 'g', flow.names[item.state] ?? ''];
  const back = new Set(item.marks.filter(mark => mark.k === 'back').map(mark => mark.t));
  const rows = [];
  for (const seg of item.segs) {
    if (!seg.over && back.has(seg.a)) rows.push('<div class="bk">Sent back</div>');
    const last = rows.at(-1);
    if (seg.over && typeof last === 'object') { last.over += seg.b - seg.a; last.d += seg.b - seg.a; continue; }
    rows.push({ k: seg.k, d: seg.b - seg.a, over: 0 });
  }
  const list = rows.map(row => typeof row === 'string' ? row : '<i class="sw s-' + row.k + '"></i><span>' + esc(flow.names[row.k]) + '</span><small class="' + (row.over ? 's' : '') + '">' + (row.over ? Math.round(row.over / MIN) + 'm past limit' : '') + '</small><b>' + Math.max(1, Math.round(row.d / MIN)) + 'm</b>').join('');
  return '<div class="t1"><span class="id">#' + item.id + '</span><span class="w">' + esc(item.who) + '</span><span class="act-chip ' + state[0] + '">' + state[1] + '</span></div><div class="t2">' + esc(item.title) + '</div><div class="segs">' + list
    + '</div><div class="t3"><span>' + clock(item.start) + ' → ' + (item.landed ? clock(item.end) : 'now') + ' · ' + Math.round((item.end - item.start) / MIN) + 'm</span></div>';
}
