/** Roadmap read models and HTML receive explicit snapshots, display fields and disclosure choices [N26,N38,C7]. */
import { heldChip } from './held-items.js';

/** Render one prepared milestone item and its in-place detail. */
export function milestoneRowHtml(row, presentation = {}) {
  const { hidden = false, open = false, root } = presentation;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const title = presentation.titleHtml ?? '<span class="muted">' + esc(row.why) + '</span>';
  const place = Number.isInteger(row.position) && row.position > 0 ? '<span class="queue-position" data-position="' + row.position + '" title="Queue position ' + row.position + '">' + row.position + '.</span> ' : '';
  const label = place + '<span class="id">' + esc(row.label) + '</span>' + title;
  const text = row.block?.dot ? '<span class="milestone-title">' + label + '</span>' + row.block.dot : label;
  const key = 'i:' + row.label;
  const status = (open && row.block?.dot ? '<span class="chip warn roadmap-blocked"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>blocked</span>' : '') + (row.stage === 'merged' ? '<span class="chip ok roadmap-landed">verified</span>' : row.stage === 'accepted' ? '<span class="chip ok">accepted</span>' : row.held ? heldChip(row.held) : row.state ? (presentation.stateChipHtml ?? '') : '<span class="chip">' + esc(row.word) + '</span>');
  const inner = '<span class="dot' + (row.state ? ' ' + row.state : '') + '"></span><span class="t">' + text + '</span>' + (row.stale || '') + '<span class="roadmap-status">' + status + '</span>';
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
    : place(a) !== null ? -1 : place(b) !== null ? 1 : rank(a) - rank(b));
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
    ? '<dl class="roadmap-stage-counts">' + [['landed','Landed'],['landing','Accepted, landing'],['review','In review'],['building','Building'],['waiting','Waiting'],['held','Held']].map(([key,label]) => '<div data-shipping-stage="' + key + '"><dt>' + label + '</dt><dd>' + next.milestone.summary[key] + '</dd></div>').join('') + '</dl>'
    : '<dl class="roadmap-stage-counts">' + stages.map(([stage, label]) => '<div data-shipping-stage="' + stage + '"><dt>' + label + '</dt><dd>' + counts[stage] + '</dd></div>').join('') + '</dl>';
  const lastShipped = '<p class="roadmap-last-shipped"><span>Last shipped</span><b>' + esc(shipped[0]?.milestone.name || 'None yet') + '</b>'
    + (shipped[0]?.milestone.note ? '<small>' + esc(firstLine(shipped[0].milestone.note)) + '</small>' : '') + '</p>';
  const mobileShipping = '<section class="roadmap-shipping roadmap-mobile-shipping" aria-label="Shipping counts">' + shippingCounts + lastShipped + '</section>';
  const mobileHistory = '<section class="roadmap-shipping roadmap-mobile-shipping" aria-label="Last shipped release">' + lastShipped + '</section>';
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
  /** Keep folding consistent with the View's other keyboard-accessible disclosure controls. */
  const wrap = (tag, classes, key, first, heading, contents, afterHead = '') => {
    const open = isOpen(key, first);
    return '<' + tag + ' class="' + classes + '" data-key="' + esc(key) + '"><div class="milestone-head" data-roadmap-key="' + esc(key) + '" role="button" tabindex="0" aria-expanded="' + open + '">' + heading.replace('<h2>', '<h2>' + caret) + '</div>' + afterHead + '<div class="milestone-body"' + (open ? '' : ' hidden') + '>' + contents + '</div></' + tag + '>';
  };
  /** Open every upcoming milestone by default; the person's current-page fold remains in the view map. */
  const card = (m) => {
    const header = headerFor(m);
    const legacyTarget = m.milestone.target ? '<div class="milestone-targetline">Target <time datetime="' + esc(m.milestone.target) + '">' + esc(targets.get(m) ?? m.milestone.target) + '</time>' + (m.milestone.pastTarget ? ' <span class="chip warn">past target</span>' : '') + '</div>' : '';
    return wrap('section', 'card-panel milestone' + (header ? ' roadmap-has-summary' : ''), 'm:' + m.milestone.name, true,
      '<h2>' + (headings.get(m) ?? esc(m.milestone.name)) + '</h2>' + (header ? header.count : count(m)) + capacity(m), body(m), header ? header.detail + (m === next ? mobileHistory : '') : legacyTarget + (m === next ? mobileShipping : ''));
  };
  /** Summarize one shipped milestone with its first note line and total count. */
  const line = (m) => wrap('div', 'milestone shipped-one', 'm:' + m.milestone.name, false, '<h2>' + esc(m.milestone.name) + '</h2><small>' + esc(firstLine(m.milestone.note)) + '</small>' + (m.milestone.shipped?.commit ? '<code class="roadmap-shipped-commit" title="' + esc(m.milestone.shipped.commit) + '">' + esc(m.milestone.shipped.commit.slice(0, 12)) + '</code>' : '') + '<span class="milestone-count">' + m.total + (m.total === 1 ? ' item' : ' items') + '</span>' + capacity(m), body(m));
  const releaseButtons = coming.map((m) => {
    const key = 'm:' + m.milestone.name;
    return '<button class="roadmap-release" data-roadmap-jump="' + esc(key) + '" type="button"><span>' + esc(m.milestone.name) + '</span><b>' + m.done + '/' + m.total + '</b></button>';
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

