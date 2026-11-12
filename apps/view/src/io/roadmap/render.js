/** Roadmap read models and HTML receive explicit snapshots, display fields and disclosure choices [N26,N38,C7]. */
import { heldChip } from "../held.js";

/** Render one prepared milestone item and its in-place detail. */
export function milestoneRowHtml(row, presentation = {}) {
  const { hidden = false, open = false, root } = presentation;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const title = presentation.titleHtml ?? '<span class="muted">' + esc(row.why) + '</span>';
  const order = Number.isInteger(row.order) && row.order > 0 ? row.order : row.position;
  const place = Number.isInteger(order) && order > 0 ? '<span class="queue-position" data-position="' + order + '" title="Queue position ' + order + '">' + order + '</span>' : '<span class="queue-position" aria-hidden="true"></span>';
  const stage = row.stage === 'claimed' ? 'building' : row.stage === 'submitted' ? 'review' : row.stage === 'back' || row.state === 'back' ? 'back'
    : row.stage === 'accepted' ? 'accepted' : row.stage === 'merged' || row.state === 'verified' ? 'landed' : 'ready';
  const icons = { building: '<path d="m3 13 5-5 3 3-5 5H3zm7-7 2-2 6 6-2 2M5 16l-2 2v2h2l2-2"/>',
    review: '<path d="M2 10s3.5-5 8-5 8 5 8 5-3.5 5-8 5-8-5-8-5Z"/><circle cx="10" cy="10" r="2"/>',
    back: '<path d="m7 5-4 4 4 4M3 9h8a5 5 0 0 1 0 10h-2"/>',
    accepted: '<path d="m3 10 5 5L17 5"/>', landed: '<path d="m3 10 5 5L17 5"/>', ready: '<circle cx="10" cy="10" r="3.5" fill="currentColor" stroke="none"/>',
    gated: '<circle cx="10" cy="10" r="7"/><path d="M10 6.5V10l2.5 2"/>', held: '<path d="M7.5 5v10M12.5 5v10"/>' };
  // The row icon shows the stage, never the Sent back mark beside it; open work that waits or is held is Gated [N26].
  const shown = stage === 'back' || stage === 'ready' ? (row.held ? 'held' : row.block?.dot || row.after?.length ? 'gated' : 'ready') : stage;
  const icon = '<span class="roadmap-state ' + shown + '" aria-hidden="true"><span class="dot ' + esc(row.state) + '"></span><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + icons[shown] + '</svg></span>';
  const label = '<span class="id">' + esc(row.label) + '</span>' + title;
  const text = '<span class="milestone-title">' + label + '</span>' + (presentation.afterHtml || '') + (row.block?.dot && !row.after?.length ? row.block.dot : '');
  const key = 'i:' + row.label;
  const labels = { building: 'Building', ready: 'Ready', review: 'In review', back: 'Sent back', accepted: 'Verified', landed: 'Merged' };
  const tones = { building: 'busy', ready: 'free', review: 'warn', back: 'no', accepted: 'ok', landed: 'ok' };
  const status = presentation.stateChipHtml ?? (row.held ? heldChip(row.held) : '<span class="chip ' + tones[stage] + ' roadmap-stage-chip">' + labels[stage] + '</span>');
  const inner = place + icon + '<span class="t">' + text + (row.stageHtml ? '' : row.stale || '') + '</span><span class="roadmap-status">' + status + '</span>';
  const board = row.open && row.open.root !== root ? ' data-board="' + esc(row.open.root) + '"' : '';
  const toggle = 'class="milestone-item' + (row.block?.dot ? ' blocked' : '') + '" data-roadmap-key="' + esc(key) + '" aria-expanded="' + open + '"' + board + ' title="' + esc(row.title ? row.title + (!row.open && row.why ? ' (' + row.why + ')' : '') : row.why) + '"';
  const detail = row.block ? row.block.detail : '<p>' + esc(row.why || row.word) + '</p>';
  // Every row stays on the Roadmap; only its explicit Open in Items link navigates (#605).
  return '<li' + (hidden ? ' hidden' : '') + '><div ' + toggle + ' role="button" tabindex="0">' + inner + '</div>'
    + '<div class="milestone-why"' + (open ? '' : ' hidden') + (row.pending ? ' aria-busy="true"' : '') + '>' + detail + '</div></li>';
}

/** Rank explicit rows and preserve modern or legacy shipment counts without a live board. */
export function readMilestoneModel(milestone, inputRows) {
  const visible = inputRows.filter((row) => row.state !== 'withdrawn');
  const verified = visible.filter((row) => row.state === 'verified');
  /** Group work in the legend's shipping order; stable sorting preserves milestone order within each group. */
  const rank = (row) => row.stage === 'merged' ? 6
    : row.stage === 'accepted' ? 0 : row.stage === 'submitted' ? 1
      : row.held ? 5 : row.stage === 'claimed' ? 2
        : row.state === 'verified' ? 6 : row.state === 'back' ? 3 : 4;
  /** Open items carry the backend's queue position; that order stands and is never re-sorted by lifecycle. */
  const place = row => Number.isInteger(row.position) && row.position > 0 ? row.position : null;
  const rows = [...visible].sort((a, b) => place(a) !== null && place(b) !== null ? place(a) - place(b)
    : place(a) !== null ? -1 : place(b) !== null ? 1 : rank(a) - rank(b)).map((row, index) => ({ ...row, order: index + 1 }));
  // Current API milestones own their landed count and explicit shipment. Old exports retain their old count.
  /** Reject malformed snapshot counts before they reach numeric HTML attributes. */
  const numeric = value => Number.isInteger(value) && value >= 0 ? value : null;
  const done = numeric(milestone.summary?.landed) ?? numeric(milestone.landed) ?? verified.length;
  const total = numeric(milestone.summary?.total) ?? numeric(milestone.total) ?? rows.length;
  // Nothing left (every item landed or withdrawn) is finished and sits under Shipped, shipped or not.
  const left = numeric(milestone.summary?.left), finished = milestone.items.length > 0 && (left !== null ? left === 0 : rows.every((row) => row.stage === 'merged'));
  const shipped = finished || (milestone.shipped !== undefined ? Boolean(milestone.shipped) : rows.length > 0 && verified.length === rows.length);
  return { milestone, rows, done, total, shipped };
}

/** Count the same remaining entries the shown release headers describe, retaining legacy export semantics. */
export function roadmapRemainingCount(reads) {
  let total = 0;
  for (const read of reads) {
    if (read.shipped) continue;
    const observed = read.milestone.summary?.left;
    const left = Number.isSafeInteger(observed) && observed >= 0 ? observed : Math.max(0, read.total - read.done);
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(total + left)) return null;
    total += left;
  }
  return total;
}

/** Render release cards, shipping counts and shipped history without browser state. */
export function roadmapCardsHtml(read, presentation = {}) {
  const { only = null, root, held, open = new Map(), headers = new Map(), headings = new Map(), rows: rowPresentation = new Map(), notes = new Map(), targets = new Map() } = presentation;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** Format the latest shipped date; keep this dependency inside the renderer embedded in the page script. */
  function shippedDate(milestone) {
    const instant = Date.parse(milestone?.shipped?.at || '');
    if (!Number.isFinite(instant)) return '';
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(instant) + ' · on npm';
  }
  const firstLine = text => String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) || '';
  const milestones = read.map(entry => entry.milestone);
  const lead = only ? '<div class="roadmap-only"><span>' + esc(only) + '</span><button class="link" data-roadmap-all type="button">show all</button></div>' : '';
  const coming = read.filter((m) => !m.shipped && m.rows.length).concat(read.filter((m) => !m.shipped && !m.rows.length)), shipped = read.filter((m) => m.shipped).reverse();
  /** Preserve each board's disclosure choices independently. */
  const isOpen = (key, first) => open.has(JSON.stringify([root, key])) ? open.get(JSON.stringify([root, key])) : first;
  const caret = '<svg class="caret" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>'; // The view's stroke chevron, set inside the title to centre on its first line (#870).
  const next = coming.find((m) => m.rows.length) || null;
  const headerFor = entry => headers.get(entry) ?? null;
  const stages = [['open', 'Open'], ['claimed', 'Building'], ['submitted', 'In review'], ['accepted', 'Accepted'], ['merged', 'Landed']];
  const counts = headerFor(next) ? null : Object.fromEntries(stages.map(([stage]) => [stage, next ? next.rows.filter((row) => row.stage === stage).length : 0]));
  const shippingCounts = headerFor(next)
    ? '<dl class="roadmap-stage-counts">' + [['landed','Landed'],['landing','Accepted, landing'],['review','In review'],['building','Building'],['waiting','Waiting'],['held','Held']].map(([key,label]) => '<div data-shipping-stage="' + key + '"><dt><i class="roadmap-stage-swatch ' + key + '" aria-hidden="true"></i>' + label + '</dt><dd>' + next.milestone.summary[key] + '</dd></div>').join('') + '</dl>'
    : '<dl class="roadmap-stage-counts">' + stages.map(([stage, label]) => '<div data-shipping-stage="' + stage + '"><dt><i class="roadmap-stage-swatch ' + stage + '" aria-hidden="true"></i>' + label + '</dt><dd>' + counts[stage] + '</dd></div>').join('') + '</dl>';
  const lastShipped = '<p class="roadmap-last-shipped"><span>Last shipped</span><b>' + esc(shipped[0]?.milestone.name || 'None yet') + '</b>'
    + (shipped[0] ? '<small>' + esc(shippedDate(shipped[0].milestone)) + '</small>' : '') + '</p>';
  const mobileShipping = '<section class="roadmap-shipping roadmap-mobile-shipping" aria-label="Shipping counts">' + shippingCounts + lastShipped + '</section>';
  /** Keep supplied landed progress beside an upcoming release without a modern summary. */
  const count = (m) => m.total ? '<span class="milestone-count" aria-label="' + m.done + '/' + m.total + ' landed">' + m.done + '/' + m.total + ' landed</span>' : '';
  /** Show the item count plainly, and name the limit only near capacity [N26]. */
  const capacity = (m) => {
    const count = m.milestone.count, limit = m.milestone.limit;
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(limit) || limit < 0) return '';
    const nearLimit = limit === 0 ? count === 0 : count >= limit * .9 && count <= limit * 1.1;
    return '<span class="milestone-limit">' + count + (count === 1 ? ' item' : ' items') + (nearLimit ? ' · limit ' + limit : '') + '</span>';
  };
  /** Render the existing milestone items, progress and complete note when opened. */
  const body = (read) => {
    const { milestone, rows, done, total } = read;
    const progress = headerFor(read) ? '' : '<svg class="milestone-progress" viewBox="0 0 100 1" preserveAspectRatio="none" role="progressbar" aria-label="' + esc(milestone.name) + ': ' + done + ' of ' + total + ' landed" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + done + '"><rect width="' + (total ? (100 * done) / total : 0) + '" height="1"/></svg>';
    return (rows.length ? progress + '<ul>' + rows.map((row) => milestoneRowHtml(row, { ...rowPresentation.get(row), hidden: held === milestone.name && !row.held })).join('') + '</ul>' : '<p class="milestone-empty">No items yet.</p>')
      + (milestone.note ? '<p class="milestone-note">' + (notes.get(read) ?? esc(milestone.note)) + '</p>' : '');
  };
  /** Keep folding consistent while the roadmap disclosure reuses the shared release-header presentation. */
  const wrap = (tag, classes, key, first, heading, contents, afterHead = '', sharedHeader = false) => {
    const open = isOpen(key, first);
    const head = '<div class="milestone-head' + (sharedHeader ? ' release-header-toggle' : '') + '" data-roadmap-key="' + esc(key) + '" role="button" tabindex="0" aria-expanded="' + open + '">'
      + (sharedHeader ? caret + heading : heading.replace('<h2>', '<h2>' + caret)) + '</div>';
    const summary = sharedHeader ? '<div class="release-header">' + head + afterHead + '</div>' : head + afterHead;
    return '<' + tag + ' class="' + classes + '" data-key="' + esc(key) + '">' + summary + '<div class="milestone-body"' + (open ? '' : ' hidden') + '>' + contents + '</div></' + tag + '>';
  };
  /** Open every upcoming milestone by default; the person's current-page fold remains in the view map. */
  const card = (m) => {
    const header = headerFor(m);
    const legacyTarget = m.milestone.target ? '<div class="milestone-targetline">Target <time datetime="' + esc(m.milestone.target) + '">' + esc(targets.get(m) ?? m.milestone.target) + '</time>' + (m.milestone.pastTarget ? ' <span class="chip warn">past target</span>' : '') + '</div>' : '';
    const heading = header ? header.top : '<h2>' + (headings.get(m) ?? esc(m.milestone.name)) + '</h2>' + count(m) + capacity(m);
    const detail = header ? header.detail : legacyTarget;
    return wrap('section', 'card-panel milestone' + (header ? ' roadmap-has-summary' : ''), 'm:' + m.milestone.name, true,
      heading, body(m), detail + (m === next ? mobileShipping : ''), Boolean(header));
  };
  /** Summarize one shipped milestone with its first note line and total count. */
  const line = (m) => wrap('div', 'milestone shipped-one', 'm:' + m.milestone.name, false, '<h2>' + esc(m.milestone.name) + '</h2><small>' + esc(firstLine(m.milestone.note)) + '</small>' + '<span class="milestone-count">' + m.total + (m.total === 1 ? ' item' : ' items') + '</span>' + capacity(m), body(m), (m.milestone.shipped?.commit ? '<button class="hash-copy" type="button" title="' + esc(m.milestone.shipped.commit) + '" aria-label="Copy full hash ' + esc(m.milestone.shipped.commit) + '" data-copy="' + esc(m.milestone.shipped.commit) + '"><code class="roadmap-shipped-commit" title="' + esc(m.milestone.shipped.commit) + '">' + esc(m.milestone.shipped.commit.slice(0, 12)) + '</code></button>' : ''));
  const releaseButtons = coming.map((m) => {
    const key = 'm:' + m.milestone.name;
    const total = Math.max(1, m.total), done = Math.min(m.done, total);
    const progress = '<svg class="roadmap-release-progress" viewBox="0 0 ' + total + ' 1" preserveAspectRatio="none" role="img" aria-label="' + esc(m.milestone.name) + ': ' + m.done + ' of ' + m.total + ' landed"><rect width="' + done + '" height="1"/></svg>';
    return '<button class="roadmap-release" data-roadmap-jump="' + esc(key) + '" type="button"><span>' + esc(m.milestone.name) + '</span><b>' + m.done + '/' + m.total + '</b>' + progress + '</button>';
  }).join('');
  const shippedButton = shipped.length
    ? '<button class="roadmap-release" data-roadmap-jump="shipped" type="button"><span>Shipped</span><b>' + shipped.length + '</b></button>' : '';
  const releasePanel = '<aside class="card-panel roadmap-panel" id="roadmap-panel" aria-label="Roadmap releases and shipping">'
    + '<section class="roadmap-release-index"><h2>Releases</h2><nav class="roadmap-releases" id="roadmap-releases" aria-label="Roadmap releases">' + releaseButtons + shippedButton + '</nav></section>'
    + '<section class="roadmap-shipping roadmap-desktop-shipping" aria-label="Shipping counts"><h2>Shipping</h2><h3 class="roadmap-next-release">' + esc(next?.milestone.name || 'No upcoming release') + '</h3>'
    + shippingCounts + lastShipped + '</section></aside>';
  const roadmapList = '<div class="roadmap-list" id="roadmap-list">' + lead + (milestones.length ? coming.map(card).join('') : '<div class="card-panel empty">No milestones yet. The coordinator adds one with <code class="inline">pullboard milestone add</code>.</div>')
    + (shipped.length ? wrap('section', 'card-panel shipped', 'shipped', false, '<h2>Shipped</h2><span class="milestone-count">' + shipped.length + (shipped.length === 1 ? ' release' : ' releases') + '</span>', shipped.map(line).join('')) : '') + '</div>';
  // With no releases there is nothing to jump to, so the Roadmap is its list alone, as before the panel.
  return (milestones.length ? releasePanel : '') + roadmapList;
}

