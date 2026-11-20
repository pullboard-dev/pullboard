/** Render only the selected board pane while preserving shared navigation and status [N26]. */
import { needsActionsHtml } from "../../logic/needs/actions.js";
import { needsPanelHtml } from "../../logic/needs/panel.js";
import { agentsPanelModel } from "../../logic/panel/model.js";
import { shoutsModel } from "../../logic/panel/model.js";
import { agentsPanelHtml } from "../../logic/panel/render.js";
import { shoutsHtml } from "../../logic/panel/render.js";
import { itemPanelModel } from "../../logic/panel/item.js";
import { itemPanelHtml } from "../../logic/panel/item.js";
import { needsPanelModel } from "../../logic/needs/panel.js";
import { itemsNeedsModel } from "../../logic/needs/panel.js";
import { itemsNeedsHtml } from "../../logic/needs/panel.js";
import { LEAKS } from "../../logic/needs/list.js";
import { PLAIN_FALLBACK } from "../../logic/needs/list.js";
import { plainNeedWords } from "../../logic/needs/list.js";
import { ruleListModel } from "../../logic/rules.js";
import { filterByField } from "../../logic/selection.js";
import { selectItemsView } from "../../logic/selection.js";
import { overlapHtml } from "../../logic/overlap.js";
import { patchKeyedRows } from "../../logic/page/rows.js";
import { navPages } from "../../logic/nav.js";
import { placeQuery } from "../../logic/nav.js";
import { readPlaceQuery } from "../../logic/nav.js";
import { readRoadmapPlace } from "../../logic/nav.js";
import { withPlaceQuery } from "../../logic/nav.js";
import { accountHtml } from "../../logic/nav.js";
import { accountMenuHtml } from "../../logic/nav.js";
import { navLayout } from "../../logic/nav.js";
import { pageControlsHtml } from "../../logic/nav.js";
import { rowWindow } from "../../logic/page/window.js";
import { notchPreview } from "../../logic/notch/preview.js";
import { notchPreviewData } from "../../logic/notch/preview.js";
import { notchPreviewHtml } from "../../logic/notch/preview.js";
import { notchRulings } from "../../logic/notch/preview.js";
import { notchFloor } from "../../logic/notch/preview.js";

/** Return the shared browser-scope renderer without eagerly building hidden pane DOM. */
export function pageRenderScript() {
  return `let drawnRoadmap = null;
let roadmapNodes = new Map();
const agentsPanelModel = (${agentsPanelModel.toString()});
const shoutsModel = (${shoutsModel.toString()});
const shoutsHtml = (${shoutsHtml.toString()});
const agentsPanelHtml = (${agentsPanelHtml.toString()});
const itemPanelModel = (${itemPanelModel.toString()});
const itemPanelHtml = (${itemPanelHtml.toString()});
const itemTimelines = new Map();
const ruleListModel = (${ruleListModel.toString()});
const filterByField = (${filterByField.toString()});
const selectItemsView = (${selectItemsView.toString()});
const patchKeyedRows = (${patchKeyedRows.toString()});
const rowWindow = (${rowWindow.toString()});
const overlapHtml = (${overlapHtml.toString()});
const PLAIN_FALLBACK = (${JSON.stringify(PLAIN_FALLBACK)});
const LEAKS = [${LEAKS.map(String).join(",")}];
const plainNeedWords = (${plainNeedWords.toString()});
const needsPanelModel = (${needsPanelModel.toString()});
const itemsNeedsModel = (${itemsNeedsModel.toString()});
const itemsNeedsHtml = (${itemsNeedsHtml.toString()});
const needsActionsHtml = (${needsActionsHtml.toString()});
// The navigation's page list and each place's address, as declarations so every part of the page may call them [N26,N38].
${navPages.toString()}
${placeQuery.toString()}
${readPlaceQuery.toString()}
${readRoadmapPlace.toString()}
${withPlaceQuery.toString()}
${accountHtml.toString()}
${accountMenuHtml.toString()}
${navLayout.toString()}
${pageControlsHtml.toString()}
${notchPreviewHtml.toString()}
${notchPreviewData.toString()}
${notchPreview.toString()}
${notchRulings.toString()}
${notchFloor.toString()}
let notchHover = null, notchBoard = null, notchAgents = 0;

/** Show a full commit value on hover and copy while keeping the visible hash concise. */
function hashButton(value) {
  const hash = String(value ?? '');
  const short = hash.slice(0, 12);
  return '<button class="hash-copy" type="button" title="' + esc(hash) + '" aria-label="Copy full hash ' + esc(hash) + '" data-copy="' + esc(hash) + '"><code class="inline sha" title="' + esc(hash) + '">' + esc(short) + '</code></button>';
}

/** Read only paths from the brief's Files section, using the board's labelled-section grammar. */
function panelFiles(brief) {
  let inFiles = false;
  const lines = [];
  for (const raw of String(brief ?? '').split(/\\r?\\n/u)) {
    const line = raw.trim();
    const label = /^(files|change|test|out of scope|reference)\\s*:\\s*(.*)$/iu.exec(line);
    if (label) {
      inFiles = label[1].toLowerCase() === 'files';
      if (inFiles && label[2]) lines.push(label[2]);
    } else if (inFiles && line) lines.push(line.replace(/^[-*]\\s+/u, ''));
  }
  const tokens = lines.flatMap(line => line.replace(/\\([^)]*\\)/gu, ' ').split(/[\\s,]+/u));
  return [...new Set(tokens.map(token => token.replace(/^[(' "]+/gu, '').replace(/[).,;:!?]+$/gu, ''))
    .filter(token => !/^[\\d.]+$/u.test(token) && !/^[a-z]+:\\/\\//iu.test(token)
      && (token.includes('/') || /\\.[a-z0-9]+(?:\\.[a-z0-9]+)*$/iu.test(token))))];
}

/** Render literal gate paths from the server's existence observations. */
function specGateFiles(row, detail = false) {
  const files = row.gateFiles || (row.gate ? [{ file: row.gate, exists: null }] : []);
  return files.map(gate => '<span class="spec-gate' + (gate.exists === false ? ' missing' : '') + '"><span aria-hidden="true">⚗</span> <code>' + esc(gate.file) + (gate.exists === false ? ' · missing' : '') + '</code>'
    + (detail && gate.ref ? codeRef(gate.ref, '', true, 12, 'Open') : '') + '</span>').join('');
}

/** Show a file only when the server observed it in the project; prose gates become readable check names. */
function doctrineCheck(row, detail = false) {
  const files = (row.gateFiles || []).filter(gate => gate.exists === true);
  if (files.length) return specGateFiles({ ...row, gateFiles: files }, detail);
  const gate = String(row.gate || '').toLowerCase();
  const label = /commit(?:-msg|-message| message)? hook/u.test(gate) ? 'Commit hook + review'
    : /project(?:'s|’s) gate/u.test(gate) ? "The project's gate" : 'Checked in review';
  return '<span class="doctrine-check">' + esc(label) + '</span>';
}

/** Derive one presentation for both the ordinary stage and the held-seat chip. */
function stageOfItem(item, project = {}, gated = false, gateDetail = '') {
  const landing = (project.landingBatches || []).find(batch => (batch.items || []).some(entry => entry.id === item.id));
  const namedItem = { ...item, owner: item.owner ? agentName(item.owner, project) : item.owner,
    reviewer: item.reviewer ? agentName(item.reviewer, project) : item.reviewer,
    claim: item.claim?.by ? { ...item.claim, by: agentName(item.claim.by, project) } : item.claim };
  const stage = itemStagePresentation(namedItem, { gated, landingBatchAt: landing ? when(landing.startedAt) : null,
    withdrawnFrom: item.withdrawnFrom || withdrawnFromStatus(item), gateDetail: item.withdrawnReason || gateDetail });
  return stage;
}

/** Render the approved item stage, its plain detail and any explanatory marks. */
function stageMarkup(item, project = {}, gated = false, gateDetail = '', marks = [], compact = false, roadmap = false, brief = false) {
  const stage = stageOfItem(item, project, gated, gateDetail);
  // A Roadmap row names only the stage, with Landed for Merged; the route and holder stay in the title for hover and readers [N26].
  const word = roadmap && stage.stage === 'Merged' ? 'Landed' : stage.stage;
  return '<span class="item-stage" data-stage="' + esc(itemStageKey(stage.stage)) + '" role="group" title="' + esc(stage.stage === 'Blocked' ? stageSentence(stage.stage, stage.detail) : stage.detail) + '" aria-label="' + esc(stageSentence(stage.stage, stage.detail)) + '"><span class="stage-line">' + (compact ? '<span class="chip item-status ' + esc(stateOf(item)) + '">' : '') + '<b class="stage-word">' + esc(word) + '</b>' + (compact ? '</span>' : '')
    + (marks.length ? '<span class="stage-marks">' + marks.join('') + '</span>' : '') + '</span>' + (roadmap || brief ? '' : '<small class="stage-detail" title="' + esc(stage.detail) + '">' + esc(stage.detail) + '</small>') + '</span>';
}

/** Make a mark's reason available on hover and to assistive readers while the row remains tappable. */
function stageMark(label, reason, tone = '') {
  const title = label + (reason ? ': ' + reason : '');
  return '<span class="stage-mark' + (tone ? ' ' + esc(tone) : '') + '" role="img" title="' + esc(title) + '" aria-label="' + esc(title) + '">' + esc(label) + '</span>';
}

/** Keep every state mark beside the stage; the row detail and tooltip retain its full reason. */
function itemStageMarks(item, project) {
  const marks = [];
  const held = heldNote(item, project, undefined, Date.now());
  if (held) marks.push(stageMark(held.startsWith('lane ') ? 'Lane held' : 'Held', held.replace(/^(?:held|lane [^ ]+ held):?\\s*/u, ''), 'gate'));
  if (item.verdict?.decision === 'REJECT' && item.status !== 'verified') {
    const reason = [activityWords({ cause: item.verdict.reason }).label, visibleVerdictNote(item.verdict.reason, item.verdict.note)].filter(Boolean).join(': ');
    marks.push(stageMark('Sent back', reason, 'no'));
  }
  const stale = staleChip(item);
  if (stale) marks.push(stale);
  if (item.status === 'withdrawn') marks.push(stageMark('Withdrawn', item.withdrawnReason || 'reason unavailable', 'no'));
  return marks;
}

/**
 * The navigation's board numbers: the notch's three (agents at work, landed per hour, rulings), the switcher's amber
 * rulings count, and each menu page's fact. Text only, so the shell never redraws.
 */
function drawNav(p, { agents = 0, agentNames = [], building = 0, review = 0, active = 0 } = {}) {
  const pace = p.dashboardPace && Number.isFinite(p.dashboardPace.last6h) ? p.dashboardPace.last6h / 6 : null;
  const rulings = Number.isInteger(p.counts?.rulings) ? p.counts.rulings : (Array.isArray(p.needs) ? p.needs : personNeeds(p)).length;
  const text = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
  // The preview reads what this page holds when the pointer arrives, never the board: the project, its recent events and its calls [#6651].
  notchBoard = p; notchAgents = agents;
  if (!notchHover && $('notch')) notchHover = notchPreview($('notch'), () => {
    const board = notchBoard, kept = dashboardView.held(board.root);
    const state = kept ? kept.state : dashboardModel(board, board.events || [], { now: Date.now(), complete: false });
    const { items, oldest } = notchRulings(Array.isArray(board.needs) ? board.needs : personNeeds(board), plainNeedWords, ago);
    return notchPreviewData({ floor: notchFloor(state, notchAgents, board.dashboardPace || null), rulings: items, oldest });
  });
  // The top bar shows the state's one agents count, as the Dashboard and Activity do (#7310); the joined seats are named in the tooltip and the Dashboard heading (#7945).
  const seats = Number.isInteger(p.counts?.joined) ? p.counts.joined : 0;
  text($('notch')?.querySelector?.('[data-notch="agents"]'), String(agents));
  text($('notch')?.querySelector?.('[data-notch="perHour"]'), pace === null ? '—/h' : Math.round(pace) + '/h');
  const ruled = $('notch')?.querySelector?.('[data-notch="rulings"]');
  text(ruled, String(rulings));
  ruled?.classList?.toggle('a', rulings > 0);
  $('notch')?.querySelector?.('[data-peek="agents"]')?.setAttribute('title', agents ? 'At work: ' + agentNames.join(', ') + '. Open the Agents table.' : seats ? seats + ' joined, none at work. Open the Agents table.' : 'No agent at work. Open the Agents table.');
  text($('proj-rulings'), rulings ? String(rulings) : '');
  // The menu drawer (under 900 px) holds the same numbers: the button's and the project's rulings, agents, pace and Rulings.
  text($('menu-rulings'), rulings ? String(rulings) : '');
  text($('mdrawer-rulings'), rulings ? String(rulings) : '');
  text($('mdrawer')?.querySelector?.('[data-notch="agents"]'), String(agents));
  text($('mdrawer')?.querySelector?.('[data-notch="perHour"]'), pace === null ? '—/h' : Math.round(pace) + '/h');
  text($('mdrawer')?.querySelector?.('[data-notch="rulings"]'), String(rulings));
  // Each page's one fact, in the sidebar's rows and the strip's menus: the pace, the open items, the release's work left, the rows.
  const release = nextMilestone(p);
  const facts = { items: active || '',
    roadmap: release && release.total > release.done ? release.total - release.done + ' to go' : '', spec: (p.spec || []).length, doctrine: (p.practice || []).length };
  for (const [page, value] of Object.entries(facts)) document.querySelectorAll?.('[data-nav-fact="' + page + '"]').forEach((node) => text(node, value ? String(value) : ''));
}

/**
 * Draw the page's frame while the shown board's state is on its way: the tabs, the current tab marked, and the
 * current screen's cards, empty. The board list has already answered, so a machine with no board never flashes it.
 * Its two-column screens keep their detail column, so the frame does not jump when the board fills it in (#6589).
 */
function drawFrame() {
  const group = String(view.root || '').startsWith('group:');
  document.body.classList.remove('loading', 'boardless');
  $('tabs').hidden = group;
  if ($('sidenav')) $('sidenav').hidden = group;
  document.querySelectorAll('.tab, .side-row').forEach((button) => button.classList.toggle('on', button.dataset.tab === view.tab));
  const frame = $('board-frame');
  frame.dataset.screen = group ? 'group' : view.tab;
  frame.classList.toggle('two', !group && ['items', 'shouts', 'spec', 'doctrine'].includes(view.tab));
  frame.classList.toggle('narrow', !group && view.tab === 'shouts');
  frame.hidden = false;
  $('project-loading').hidden = false;
  $('live').textContent = '';
}

/**
 * Draw the Roadmap by row key (#6679): a row whose markup is unchanged keeps its DOM node, and a live update replaces only
 * the rows that changed.
 *
 * @param {string} html - The cards, each row an empty slot.
 * @param {Map<string, string>} rows - Each row's markup by its slot key.
 * @param {string|null} board - The board the Roadmap shows.
 */
function paintRoadmap(html, rows, board) {
  const done = patchKeyedRows({ host: $('roadmap'), doc: document, nodes: roadmapNodes, drawn: drawnRoadmap, html, rows, scope: JSON.stringify([view.root, board]) });
  roadmapNodes = done.nodes;
  drawnRoadmap = done.drawn;
}

/** The person's rulings on a board state, read once per state, not on every click or draw (#6851). */
function personalNeedsOf(project) {
  return store.select('person-needs', [project], () => {
    const p = privateModelProject(project);
    return personNeeds({ ...p, agents: (p.agents || []).map(agent => ({ ...agent, displayName: agentName(agent.agent_id, p) })) });
  });
}

// The Items rows drawn last, and the slice of them on screen (#6676).
let itemsList = null;
let itemsPitch = 0;
// The Items rows on screen by item id: a live update, a click or a scroll replaces only the rows whose markup changed (#6851).
let itemsNodes = new Map();
let itemsDrawn = null;
// What the Items rulings panel was last drawn from (#6851).
let itemsNeedsDrawn = null;
/** Draw only the Items rows near the viewport; the list's height stays whole so the scrollbar and every anchor stay right. */
function paintItemsWindow() {
  const chain = $('chain'), list = itemsList;
  if (!chain || !list) return;
  const rows = list.shown;
  if (!itemsPitch && typeof getComputedStyle === 'function') {
    const style = getComputedStyle(chain), row = parseFloat(style.getPropertyValue('--item-row-h')), gap = parseFloat(style.rowGap) || 0;
    if (row > 0) itemsPitch = row + gap;
  }
  const viewport = typeof innerHeight === 'number' ? innerHeight : 0;
  // Without a measured row height or a viewport (a page with no layout), every row is drawn.
  const windowed = rows.length > 0 && itemsPitch > 0 && viewport > 0 && typeof chain.getBoundingClientRect === 'function';
  const at = windowed ? rowWindow({ count: rows.length, top: chain.getBoundingClientRect().top, viewport, pitch: itemsPitch }) : { start: 0, end: rows.length };
  // A page that cannot parse rows into nodes (a bare test page) draws the slice whole, as it always did.
  if (!rows.length || !document.createElement('template').content) {
    store.paint(chain, rows.length ? rows.slice(at.start, at.end).map(list.rowHtml).join('') : list.empty);
    itemsNodes = new Map();
    itemsDrawn = null;
  } else {
    const markup = new Map(rows.slice(at.start, at.end).map(item => [String(item.id), list.rowHtml(item)]));
    // A list someone else rewrote since is drawn whole again.
    const kept = itemsDrawn !== null && [...itemsNodes.values()].every(entry => entry.node.parentNode === chain);
    const done = patchKeyedRows({ host: chain, doc: document, nodes: kept ? itemsNodes : new Map(), drawn: kept ? itemsDrawn : null,
      html: [...markup.keys()].map(key => '<li data-slot="' + key + '"></li>').join(''), rows: markup, scope: String(view.root), ageless: true });
    itemsNodes = done.nodes;
    itemsDrawn = done.drawn;
  }
  const above = windowed && at.start ? at.start * itemsPitch : 0, below = windowed && at.end < rows.length ? (rows.length - at.end) * itemsPitch : 0;
  chain.dataset.geo = 'items-chain';
  // Important: '.list-card > .chain { padding: 0 }' is more specific than the geometry rule, and without these paddings the page is only as
  // tall as the drawn rows, so a scroll to a far row is clamped, moves the window and never settles (#7487).
  geometry('items-chain', above || below ? { 'padding-top': above + 'px !important', 'padding-bottom': below + 'px !important' } : null);
}

// The parts that scroll on their own: each keeps its place through any draw (#6613).
const SCROLLED_PARTS = ['proj-list', 'item-list', 'chain', 'detail', 'pipeline', 'feed', 'agents', 'spec-list', 'spec-detail', 'doctrine-list', 'doctrine-detail', 'activity', 'roadmap-panel', 'dashboard', 'insights-pipeline', 'cost'];
/**
 * Run fn once, after the browser has painted the change just made: on the next frame, then on a fresh turn. Why: a press
 * should show its result at once and let the heavier redraw follow; a page with no frames runs it on the next turn.
 */
function afterPaint(fn) {
  const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (next) => next();
  frame(() => setTimeout(fn, 0));
}

/**
 * Draw the page from the store (#6613). The sidebar and the chrome are drawn on every call; the shown tab's pane is
 * drawn unless this is a tab switch and the pane still shows what it was drawn from. Every part is written through
 * store.paint, so a live update rewrites only the parts whose markup changed, and each scrolled part keeps its place.
 *
 * @param {{ tab?: boolean }} [options] - tab: this draw is a tab switch, which reuses a pane drawn from the same state.
 */
function render({ tab: switching = false } = {}) {
  renderIndexes = new WeakMap();
  // A refresh that moved the page to another board closes a confirmation opened on the last one.
  closeIfLeft();
  if (heldClickPointer !== null || pageDialogs.size) { deferredClickRender = true; return; }
  deferredClickRender = false;
  // Anything but a tab switch may change what any pane shows, so a pane drawn before it is drawn again on its switch.
  if (!switching) store.invalidate();
  const scrolled = store.scrollMark([document.scrollingElement, ...SCROLLED_PARTS.map((id) => $(id))]);
  const p = privateModelProject(data.project);
  const group = data.group;
  // An open-first state holds no finished items: the screens that show them (Activity titles every row by item) read them now (#6697, #7756).
  // The Dashboard's landed panels name items the open-first state left out, so it reads them when a recent landing has none (#7945).
  const unnamed = view.tab === 'dashboard' && (data.project?.dashboardLanded ?? []).some((entry) => !data.project.items.some((item) => item.id === entry.id));
  if (data.project?.itemsOmitted === 'finished' && (unnamed || view.tab === 'roadmap' || view.tab === 'activity' || view.tab === 'items' && (['verified', 'all'].includes(view.state)
    || view.itemsView === 'pipeline' || $('q').value.trim() || view.item && !data.project.items.some((item) => item.id === view.item)))) ensureFinished(data.project);
  renderSide();
  writeChrome();
  // A list that names a board no read has answered yet is still loading, never a machine without boards (#1035).
  const listing = !p && !group && data.projects.some((entry) => entry.ok);
  $('project-loading').hidden = data.root === view.root && !listing;
  if (data.root !== view.root || listing) {
    // Keep the cached picker available, but never label the last board's counts as the new one.
    document.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = true; });
    for (const id of ['products', 'group-view', 'upgrade-note', 'person-requests', 'credentials', 'find-results']) $(id).hidden = true;
    // The tabs and the screen's empty cards stand while its board state is on its way, never a blank page (#6589).
    if (data.projects.some((entry) => entry.ok)) drawFrame();
    else $('live').textContent = 'Loading project…';
    return;
  }
  $('board-frame').hidden = true;
  if (view.answering && view.answering.root !== view.root) answer(null);
  // Until the first board arrives the page shows no tabs or panes, so a machine with none never
  // flashes them; with no board to show, one message says how a board starts, in their place.
  document.body.classList.remove('loading');
  document.body.classList.toggle('boardless', !p && !group);
  $('group-view').hidden = !group;
  $('tabs').hidden = Boolean(group);
  if ($('sidenav')) $('sidenav').hidden = Boolean(group);
  document.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = Boolean(group) || pane.dataset.pane !== view.tab; });
  $('products').hidden = !p || !p.products.length;
  renderReleaseNotes(group ? null : p);
  renderHostedReleaseNote(p);
  const grew = renderPersonRequests(p);
  // The page scroll is put back at the end of this draw; a panel that grew above the view moves that mark with it.
  const page = scrolled.find(([element]) => element === document.scrollingElement);
  if (page && grew) page[1] += grew;
  renderCredentials();
  // A board's Settings pane still refreshes the shared status counts; machine-only Settings has no board to render.
  if (view.tab === 'settings' && !p) { $('group-view').hidden = true; showTab(); return; }
  if (group) { renderGroup(group); return; }
  if (!p) return;
  // A tab switch to a pane drawn from this same board and view shows it as it is, with nothing drawn again.
  const draw = !(switching && store.paneFresh(view.tab, store.paneKey(view, $('q').value)));
  // A switch to the Roadmap after an update shows it as it was last drawn at once; the patch for the update follows once
  // that frame is on screen, so the switch never waits on the rows that changed (#6679).
  const roadmapBehind = draw && switching && view.tab === 'roadmap' && drawnRoadmap !== null
    && drawnRoadmap.scope === JSON.stringify([view.root, p.board ?? data.projects.find(project => project.root === view.root)?.id ?? null]);
  // Each product's progress (N28): the rows an accepted item cites, and its items by state.
  store.paint($('prod-list'), p.products.map((x) => {
    const states = [['open', '', x.items.open], ['building', 'building', x.items.claimed], ['to verify', 'verify', x.items.submitted], ['verified', 'verified', x.items.verified]].filter(([, , n]) => n);
    return '<div class="prod" title="' + x.rows + ' rows in force, ' + x.approved + ' approved, ' + x.proven + ' cited by accepted items"><p><b>' + esc(x.name) + '</b><span>' + x.proven + '/' + x.rows + ' rows met</span></p><svg class="bar" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><rect width="' + (x.rows ? Math.round((100 * x.proven) / x.rows) : 0) + '" height="1"/></svg>'
      + (states.length ? '<small>' + states.map(([label, dot, n]) => '<span><i class="dot ' + dot + '"></i>' + n + ' ' + label + '</span>').join('') + '</small>' : '') + '</div>';
  }).join(''));
  const items = p.items.filter((i) => i.status !== 'withdrawn');
  const titles = renderIndex(p).titles;
  const lanes = p.lanes, working = lanes.filter((lane) => lane !== 'coordinator');
  const heldLanes = new Map(p.holds.map((hold) => [hold.hold_lane, hold]));
  const gatedOf = (item) => item.status === 'open' && (item.blockedBy.length > 0 || heldLanes.has(item.lane) || (p.itemHolds || []).some((hold) => hold.item === item.id));
  // The Pipeline page draws itself from the held event history on every refresh and tab switch; it needs no Rulings (#6869).
  if (view.tab === 'pipeline') pipelineView.draw(p);
  if (draw && view.tab === 'cost' && privateCost && !snapshot && !hosted.local && !readOnly && !data.group) {
    const history = readCostHistory(p, switching);
    store.paint($('cost'), costPaneHtml(history, p));
  }
  if (roadmapBehind) afterPaint(() => { if (view.tab === 'roadmap') render(); });
  if (draw && !roadmapBehind && view.tab === 'roadmap') {
  // Every refresh redraws the Roadmap. Left alone, that would send the phone's release chips back to their start
  // and the panel back to its top under a person mid-scroll, so both keep where they were.
  const chipsAt = $('roadmap-releases')?.scrollLeft ?? 0, panelAt = $('roadmap-panel')?.scrollTop ?? 0;
  roadmapAhead.clear();
  roadmapDetails.clear();
  const roadmapRows = new Map();
  const roadmap = roadmapCards(p, titles, roadmapRows), roadmapHtml = roadmap.html;
  const roadmapBoard = p.board ?? data.projects.find(project => project.root === view.root)?.id ?? null;
  paintRoadmap(roadmapHtml, roadmapRows, roadmapBoard);
  restoreRoadmapArrival();
  // The mark sets its chip in bold, which widens it, and the fresh row has no mark yet. Restored first, the scroll
  // would clamp to a row narrower by that bold and leave the chips short of where they were (#452).
  if ($('roadmap-releases')) $('roadmap-releases').scrollLeft = chipsAt;
  if ($('roadmap-panel')) $('roadmap-panel').scrollTop = panelAt;

  }

  // Settings carries the rules and useful-agents cards that used to sit on the Dashboard.
  if (view.tab === 'settings') $('settings-reference').innerHTML = '<section id="dashboard-rules" class="dash-card" aria-label="Your rules">' + homeRules(p.spec) + '</section><section id="dashboard-capacity" class="dash-card" aria-label="Useful agents">' + homeCapacity(p.capacityForecast) + '</section>';
  // What needs the person, first, and only the person's calls (B26): the decisions passed up to them,
  // questions in the spec, held lanes, then draft rows. Work waiting for a verdict or sent back shows
  // on the board with who holds it; it is the agents' to move.
  const needsTab = draw && ['items', 'dashboard'].includes(view.tab);
  const personalNeeds = needsTab || draw && ['spec', 'doctrine'].includes(view.tab) ? personalNeedsOf(data.project) : [];
  const agentApprovals = personalNeeds.filter(row => row.kind === 'agent-approved');
  if (needsTab) {
  const person = !snapshot && (!readOnly || requests);
  // The rows the person opened on this board, per screen; every other row stays closed through live redraws.
  const openNeeds = place => [...(view.needsOpen?.get(JSON.stringify([view.root, place])) ?? [])];
  const expandedNeeds = openNeeds('items');
  /** Actions retain the existing person/request handlers and advertised row identities. */
  const needsControls = row => needsActionsHtml(row, { person,
    approvalHtml: row.kind === 'agent-approved' ? agentApprovalActions(row) : '',
    sentinelHtml: row.kind === 'sentinel-draft' ? sentinelDraftActions(row) : '',
  });
  const needsFeedback = row => view.specFeedback?.root===view.root && view.specFeedback.kind==='spec' && view.specFeedback.id===row.id ? specFeedback(view.specFeedback) : '';
  const approvalDateLabel = value => {
    const date = new Date(value), hour = date.getHours();
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()] + ' ' + date.getDate() + ', ' + (hour % 12 || 12) + ':' + String(date.getMinutes()).padStart(2, '0') + ' ' + (hour < 12 ? 'AM' : 'PM');
  };
  // The model and its presentation are made only when a panel is drawn: Items keeps its drawn panel through a click (#6851).
  let modelKept = null, presentationKept = null;
  const needsModel = () => modelKept || (modelKept = needsPanelModel(personalNeeds,p,{ person, expanded: expandedNeeds, quiet: true }));
  // Browser-dependent presentation is prepared from the same descriptors the pure renderer consumes.
  const needsPresentation = () => presentationKept || (presentationKept = new Map([...needsModel().questions,...needsModel().approvals].map(row => {
    const approvedAt = row.fields.find(([label]) => label === 'Approved in Git')?.[3]?.date;
    return [row.key, {
      ageHtml: row.ageAt ? age(row.ageAt) : '', bodyHtml: row.body ? rich(row.body,titles,!readOnly) : '',
      feedbackHtml: needsFeedback(row.source), controlsHtml: needsControls(row.source),
      approvalDateLabel: Number.isFinite(Date.parse(approvedAt)) ? approvalDateLabel(approvedAt) : 'Date unknown',
    }];
  })));
  const needsPanel = ${needsPanelHtml.toString()};
  if (view.tab === 'dashboard') {
    const dashboardNeeds = needsPanelModel(personalNeeds,p,{ person, expanded: openNeeds('dashboard'), compact: true });
    const behind = dashboardView.draw(p, needsPanel({...dashboardNeeds,headerSeparately:true},needsPresentation()), {
      needsHeader: needsPanel({...dashboardNeeds,headerOnly:true},needsPresentation()),
      quick: switching,
    });
    // A switch drew the last model at once; the up-to-date one follows once that frame is on screen.
    if (behind) afterPaint(() => { if (view.tab === 'dashboard') render(); });
  } else if (view.tab === 'items') {
    // Items opens on its items: questions and sentinels wait in one collapsed group above them, repeats folded [N26].
    // With nothing for the person, the top of Items holds the one quiet Rulings line.
    const open = Boolean($('needs').querySelector?.('details[data-items-needs]')?.open);
    const hidden = view.state !== 'active' || Boolean(view.lane);
    $('needs').hidden = hidden;
    $('needs').tabIndex = -1;
    // The panel is made again only when what it is made from changes: the rulings, the holds and spec rows they read, the
    // titles their references show, the address and the person's choices in it. Hidden under a filter, it keeps what it
    // holds until the rulings change. A filter click, an opened item or a live update that leaves the rulings as they were
    // draws nothing (#6851).
    // Its links carry the address's query (and, off a routed host, its path), never the opened item.
    const needsChoices = JSON.stringify([routed ? location.search : location.pathname + location.search, open, expandedNeeds, view.root, person, view.specFeedback ?? null, view.declining ?? null,
      view.declineKind ?? null, view.declineRoot ?? null, view.declineFrom ?? null, view.declineAnchor ?? null, view.declineDigest ?? null, readOnly]);
    const needsInputs = store.select('items-needs-inputs', [data.project], () => {
      const text = JSON.stringify([personalNeeds, p.holds ?? null, p.spec ?? null]);
      return text + JSON.stringify([...new Set(text.match(/#[0-9]+/g) || [])].map(ref => titles.get(ref.slice(1)) ?? null));
    });
    if (!hidden || itemsNeedsDrawn !== needsInputs) store.paint($('needs'), store.select('items-needs', [needsInputs, needsChoices], () => {
      const itemsNeeds = itemsNeedsModel(needsModel());
      const nothing = !itemsNeeds.questions.length && !itemsNeeds.approvals.length && !itemsNeeds.drafts;
      return nothing ? needsPanel(needsModel(), needsPresentation()) : itemsNeedsHtml(itemsNeeds, { open,
        questionsHtml: needsPanel({ ...itemsNeeds, approvals: [], drafts: 0 }, needsPresentation()),
        restHtml: needsPanel({ ...itemsNeeds, questions: [] }, needsPresentation()) });
    }));
    itemsNeedsDrawn = needsInputs;
  }
  }

  if (draw && view.tab === 'items') {
  // New work goes first to a lane that owns folders, where builders work, then to the coordinator; a
  // lane that owns none, such as review, is for verifiers and comes last.
  const filing = [...working.filter((l) => p.owning.includes(l)), 'coordinator', ...working.filter((l) => !p.owning.includes(l))];
  if ($('add-lane').dataset.lanes !== filing.join()) {
    $('add-lane').dataset.lanes = filing.join();
    $('add-lane').innerHTML = filing.map((l) => '<option>' + esc(l) + '</option>').join('');
  }
  const approved = p.spec.filter((r) => r.status === 'approved');
  $('add-specs').placeholder = (approved.length ? approved : p.spec).slice(0, 2).map((r) => r.id).join(',') || 'none yet';
  const q = $('q').value.trim().toLowerCase();
  const pipeline = view.itemsView === 'pipeline';
  $('item-list').hidden = pipeline;
  $('pipeline').hidden = !pipeline;
  // Each Show choice counts what it would show under the lane and the search. A search looks through every
  // state, withdrawn items included; browsing leaves those out.
  const found = searchIds(p, q);
  // Blocked is shared by the rows, filter and status bar. Capture all clocks/derived state here;
  // the pure selector receives observations and ids, never the page's data/view globals.
  // The ready order is only read when Show is Ready, so the whole dashboard is not worked out for any other choice (#6676).
  const readyIds = view.state === 'ready' ? dashboardModel(p, [], { complete: false, now: Date.now() }).next.map(item => item.id) : [];
  const stateById = new Map(p.items.map(item => [item.id, { state: stateOf(item), gated: gatedOf(item), merged: Boolean(item.merged) }]));
  const itemsSelection = selectItemsView({ items: p.items, query: q, matchedIds: found, readyIds, stateById, state: view.state,
    lane: view.lane, ids: view.itemIds || [], pipeline, dashboardList: view.dashboardList, dashboardNext: p.dashboardNext || [], selectedId: view.item,
    currentBoard: data.root === view.root, adding: view.adding,
    addressDetail: view.tab === 'items' ? view.addressDetail : null, tab: view.tab, snapshot,
    finished: p.itemsOmitted === 'finished' ? p.finished : null });
  view.lane = itemsSelection.selectedLane;
  const { matching, laneOptions, inView, shown, finishedUnderAll } = itemsSelection;
  // The lanes the strip's Lane control offers, with each one's count under the shown state (Filters live in the strip).
  const lanesKey = JSON.stringify(laneOptions.map(({ value, count }) => [value, count]));
  if (view.itemLanesKey !== lanesKey) { view.itemLanesKey = lanesKey; view.itemLanes = laneOptions; drawPageControls(); }
  store.paint($('pipeline'), pipeline ? pipelineCard(shown) : '');
  const { nextSelectedId } = itemsSelection;
  if (nextSelectedId !== view.item) view.item = nextSelectedId;
  // With nothing picked, the detail shows the first row, and keeps it when a refresh reorders the list.
  // While another project loads, the item picked there waits for its own board.

  // Items draws only the rows near the screen (#6676): the list is kept here and paintItemsWindow draws its slice.
  itemsList = { shown, rowHtml: (i) => {
    const s = stateOf(i);
    // What an open item waits on, if anything: items not yet verified, or a hold on its lane.
    const hold = s === 'open' ? heldLanes.get(i.lane) : null;
    const pills = hold ? '<span class="gate">lane held: ' + linked(hold.hold_reason, titles) + '</span>' : '';
    const holder = holderOf(i), reviewer = reviewerOf(i);
    const seat = holder || reviewer || (s === 'back' ? i.verdict?.by : null);
    const agent = p.agents.find(entry => entry.agent_id === seat);
    const model = [agent?.model, agent?.agent_model].find(value => typeof value === 'string' && value.trim() && value.trim().toLowerCase() !== 'unknown');
    const gate = i.blockedBy.length ? '' : heldNote(i, p, undefined, Date.now()) || '';
    const marks = itemStageMarks(i, p);
    const stage = stageOfItem(i, p, gatedOf(i), gate);
    const tag = stageMarkup(i, p, gatedOf(i), gate, marks, true);
    return sharedRowHtml({ className: (view.item === i.id ? 'on ' : '') + (gatedOf(i) ? 'gated ' : ''), attributes: { 'data-item': i.id }, title: i.title, state: s,
      primaryHtml: '<span>#' + i.id + '</span>' + rich(i.title, titles), timeHtml: age(i.updatedAt), chipHtml: tag, seat, chipTitle: model, seatStage: { ...stage, key: itemStageKey(stage.stage), marksHtml: marks.join('') },
      // A rejected row's second line is its verdict; any other row's is its lane and the spec ids it serves.
      metaHtml: (rejected(i) ? '<b class="item-reason">' + reasonHtml(i.verdict.reason) + '</b> <span class="why">' + linked(firstLine(visibleVerdictNote(i.verdict.reason, i.verdict.note)), titles) + '</span>'
        : '<span>' + esc(i.lane) + '</span>' + (i.specs.length ? '<span class="specs" title="' + esc(i.specs.join(', ')) + '">' + esc(i.specs.slice(0, 3).join(', ') + (i.specs.length > 3 ? ' +' + (i.specs.length - 3) : '')) + '</span>' : '')) + pills + overlapHtml(data.claimOverlaps, i.id) });
  }, empty: '<li class="empty">' + (finishedUnderAll
    ? 'Finished work is under All. <button class="link" data-filter-choice="state:all" data-filter-kind="state" data-filter-value="all" type="button">Show all</button>'
    : items.length ? 'No items match.' : snapshot ? 'No items at this event.' : 'No items yet. Add the first one with New item.') + '</li>' };
  paintItemsWindow();

  const selected = p.items.find((i) => i.id === view.item);
  // The form shows when asked for, or when the project has no item at all, withdrawn ones included.
  const adding = view.adding || (!p.items.length && !(view.tab === 'items' && view.addressDetail !== null && view.addressDetail !== 'pipeline'));
  $('add-form').hidden = !adding;
  $('add-cancel').hidden = !p.items.length;
  $('detail').hidden = adding;
  if (!selected) store.paint($('detail'), '<div class="empty">' + (view.tab === 'items' && view.addressDetail !== null && view.addressDetail !== 'pipeline' ? 'No item #' + esc(view.addressDetail) + ' exists here.' : 'Pick an item to see its criterion, verdicts and history.') + '</div>');
  const opened = selected && !view.adding ? detailOf(p, selected, view.tab === 'items' && data.root === view.root) : null;
  /** Every verdict as the shared row, with its complete note in the disclosure, newest first: the opened history keeps what the panel's one verdict section does not show. */
  const verdictRowsOf = (item) => (item.verdicts || []).toReversed().map(verdict => {
    const passed = verdict.decision === 'ACCEPT';
    const note = visibleVerdictNote(verdict.reason, verdict.note);
    const first = note.split(/\\r?\\n/u, 1)[0];
    const summary = first.length > 180 ? first.slice(0, 177) + '…' : first;
    const iconPath = passed ? 'M3.5 8.5l3 3 6-6.5' : 'M6 4 2.5 7.5 6 11M2.5 7.5H10';
    const title = passed ? 'Passed' : 'Sent back · ' + activityWords({ cause: verdict.reason }).label;
    return sharedRowHtml({ tag: 'li', variant: 'item', state: passed ? 'verified' : 'back', title: title + ' by ' + agentName(verdict.by),
      iconHtml: '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + iconPath + '"/></svg>',
      primaryHtml: '<b>' + (passed ? 'Passed' : 'Sent back · ' + reasonHtml(verdict.reason)) + '</b> <span class="muted">by ' + esc(agentName(verdict.by)) + '</span>',
      timeHtml: '<time>' + esc(when(verdict.at)) + '</time>', metaHtml: '<span class="item-verdict-note">' + inline(summary, titles) + '</span>',
      detailHtml: '<div class="verdict ' + (passed ? 'yes' : 'no') + '"><b>' + (passed ? 'Accepted · <span title="' + esc(verdict.reason) + '">' + esc(activityWords({ cause: verdict.reason }).label) + '</span>' : 'Sent back · ' + reasonHtml(verdict.reason)) + '</b><span class="by">' + esc(agentName(verdict.by)) + ' · ' + esc(when(verdict.at)) + (verdict.commit ? ' · at ' + hashButton(verdict.commit) : '') + '</span><div class="note">' + inline(note, titles) + '</div></div>' });
  }).join('');
  /** The code a typed fact refers to, each as the collapsed reference block, or a plain refusal naming what is missing. */
  const referencedCodeOf = (item) => (item.thread || []).filter((entry) => entry.type === 'fact' && entry.ref).map((fact) => {
    const ref = fact.ref;
    const path = typeof ref.path === 'string' ? ref.path : '';
    const start = ref.start;
    const end = ref.end;
    const commit = typeof ref.commit === 'string' ? ref.commit : '';
    const safePath = /^[\\w.-]+(?:\\/[\\w.-]+)*$/.test(path) && !path.split('/').some((part) => part === '.' || part === '..');
    const safeRange = Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(end) && end >= start;
    const safeCommit = /^[0-9a-f]{40}$/.test(commit);
    if (!safePath || !safeRange || !safeCommit) {
      const missing = [!safePath && 'repository path', !safeRange && 'line range', !safeCommit && 'full commit SHA'].filter(Boolean).join(', ');
      return '<div class="fact-code"><span class="chip">' + esc(eventWords(fact.kind)) + '</span> <span class="muted">' + esc(agentName(fact.by)) + ' · ' + age(fact.at) + '</span><div class="code no ref-missing" role="status">Code reference unavailable: missing or invalid ' + esc(missing) + '.</div></div>';
    }
    const range = path + ':' + start + (end === start ? '' : '-' + end) + '@' + commit;
    return '<div class="fact-code"><span class="chip">' + esc(eventWords(fact.kind)) + '</span> <span class="muted">' + esc(agentName(fact.by)) + ' · ' + age(fact.at) + '</span>' + codeRef(range, '', true) + '</div>';
  }).join('');
  /** The items this one waits on, each a link. */
  const waitsOf = (item) => (item.blockedBy || []).map(id => '<a class="ref" href="' + esc(itemAddress(id)) + '" data-go="item:' + id + '">#' + id + '</a>').join(', ');
  /** The opened item's timeline for its strip (#12162): read once, kept 30 s, a failed read (a hosted page, a relay board) leaves no strip. */
  const stripOf = (item) => {
    const key = view.root + '\\n' + item.id, kept = itemTimelines.get(key);
    if (kept && (kept.loading || Date.now() - kept.at < 30_000)) return kept.strip;
    const entry = { loading: true, at: Date.now(), strip: kept?.strip ?? null };
    itemTimelines.set(key, entry);
    api('/item-timeline/' + encodeURIComponent(String(item.id))).then((reply) => { entry.strip = reply; }, () => {}).finally(() => {
      entry.loading = false; entry.at = Date.now();
      if (entry.strip && view.item === item.id && key === view.root + '\\n' + item.id) render();
    });
    return entry.strip;
  };
  /** The opened item's whole panel from its model: the header alone while its detail loads, every section once it has arrived (#7571). */
  const drawPanel = (item) => {
    const baseline = item.checkBaseline;
    const baselineLabel = baseline?.result === 'red' ? 'red on main' : baseline?.result === 'green' ? 'green on main' : baseline?.result === 'pending' ? 'pending on main' : 'no baseline on main';
    const verdict = item.verdict;
    const model = itemPanelModel(item, { now: Date.now(), esc, name: (seat) => agentName(seat), stage: item.status === 'withdrawn' ? 'Withdrawn' : stageOfItem(item, p, gatedOf(item), '').stage,
      milestone: (p.milestones || []).find(milestone => milestone.items?.some(entry => entry.id === item.id))?.name,
      reason: (code) => activityWords({ cause: code }).label, brief: briefCopyOf(item.brief), note: verdict ? visibleVerdictNote(verdict.reason, verdict.note) : '', files: panelFiles(item.brief || ''),
      baseline: { label: baselineLabel, warn: baseline?.warning === 'CRITERION_PROVES_NOTHING' }, historyOpen: view.historyOpen?.has(JSON.stringify([view.root, view.item])) === true });
    return itemPanelHtml(model, { strip: stripOf(item), esc, rich: (text) => rich(text, titles), hash: hashButton, width: Math.max(0, (($('detail').clientWidth || 0) - 58)), overlap: overlapHtml(data.claimOverlaps, item.id), verdicts: item.verdicts?.length ? '<ul class="item-panel-verdicts">' + verdictRowsOf(item) + '</ul>' : '', refs: referencedCodeOf(item), waits: waitsOf(item), marks: itemStageMarks(item, p).filter(mark => !/aria-label="(?:Sent back|Withdrawn)/u.test(mark)).join(''), inline: (text) => inline(text, titles), timeline: item.thread ? timeline(item, { newestFirst: true }) : '', title: rich(item.title, titles),
      note: verdict ? inline(visibleVerdictNote(verdict.reason, verdict.note), titles) : '' });
  };
  /** The brief without its Files section, whose paths the panel lists as rows. */
  const briefCopyOf = (brief) => {
    let inFiles = false;
    return String(brief || '').split(/\\r?\\n/u).filter(line => {
      const label = /^(files|change|test|out of scope|reference)\\s*:/iu.exec(line.trim());
      if (label) { inFiles = label[1].toLowerCase() === 'files'; return !inFiles; }
      return !inFiles;
    }).join('\\n').trim();
  };
  if (opened?.error) store.paint($('detail'), '<div class="stack"><p class="detail-wait muted" role="status">Could not load #' + selected.id + ': ' + esc(opened.error) + '</p></div>');
  // Until its omitted fields arrive, an opened item paints its heading from its summary and fills the rest in place (#1039).
  else if (opened?.loading) store.paint($('detail'), '<div class="item-panel" aria-busy="true">' + drawPanel(selected) + '</div>');
  const item = opened?.item;
  if (item) {
    store.paint($('detail'), '<div class="item-panel">' + drawPanel(item)
      + '<div class="links"><button class="ghost" data-shout="' + esc(item.lane) + '" data-about="' + item.id + '" type="button">Shout the ' + esc(item.lane) + ' lane about #' + item.id + '</button><button class="go" data-new type="button">New item</button></div></div>');
  }

  }

  if (draw && view.tab === 'shouts') {
  // Every #id in a shout that names an item opens it, whatever stands next to it. The ids are found in
  // the raw text and each piece is escaped on its own, so an apostrophe's &#39; is never read as one;
  // a number that names no item stays text. A path:lines@commit reference opens that code (B23). It
  // counts only as a whole word, never as the tail of one, so what it opens is what it says, and the
  // view refuses what is no path in the repo.
  const hue = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 8;
  const initials = (id) => { const [name, rest = ''] = String(id).split(/[-_ ]/); const digits = rest.replace(/\\D/g, ''); return (name.slice(0, digits ? 1 : 2) + digits.slice(0, 3)).toUpperCase(); };
  const questions = [...p.decisions, ...p.asked, ...(p.decisionQueue || [])];
  const open = new Set(questions.map((d) => d.shout_id));
  view.shoutQuestions = open.size;
  // The shout's item: the first #N in its text that names an item on this board, or else its evidence's.
  const itemOf = (x) => /^item:([1-9]\\d*)$/.exec(String(x.shout_to))?.[1] || [...String(x.shout_text).matchAll(/#(\\d+)/g)].map((m) => String(Number(m[1]))).find((id) => titles.has(id)) || x.shout_evidence_item;
  // The coordinator's mark is the board's own: a square with the Pullboard logo, so it stands out from the agents.
  const LEAD = '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect width="56" height="14" x="3" y="25" fill="var(--accent)" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg>';
  const lead = (from) => from === 'coordinator';
  // Opened from the status bar's unread, the feed is exactly those shouts, the ones after the mark the person had.
  const unread = view.unread?.root === view.root ? view.unread : null;
  const addressed = addressedShouts.get(JSON.stringify([view.root, view.shout]));
  const shownShouts = addressed?.shout && !p.shouts.some((entry) => entry.shout_id === view.shout) ? [...p.shouts, addressed.shout] : p.shouts;
  const feedShouts = [...shownShouts, ...olderShoutsOf(view.root, shownShouts)];
  const heard = unread ? feedShouts.filter((x) => x.shout_id > unread.after) : view.agent ? feedShouts.filter((x) => x.shout_from === view.agent || x.shout_to === view.agent) : feedShouts;
  const bar = !unread && !view.agent ? '' : '<div class="feed-bar">' + (unread ? '<span><b>' + heard.length + '</b> unread <button class="link" data-unread type="button">show all</button></span>'
    : '<span>Shouts with <b>' + esc(agentName(view.agent)) + '</b> <button class="link" data-agent="" type="button">show all</button></span>') + '</div>';
  /** Keep model spelling consistent without rewriting the recorded message or native seat id. */
  const modelLabel = value => {
    const model = String(value || 'unknown').trim();
    if (privateCost) return modelPresentation(model).name;
    const rule = modelLabelRules.find(entry => new RegExp(entry.match, 'iu').test(model));
    if (rule) return rule.label;
    return model;
  };
  const modelOf = id => modelLabel(p.agents.find(agent => agent.agent_id === id)?.model);
  /** Share the original native notice formatting between previews and full messages, preserving authored words. */
  const messageText = message => findingWords({ why: message.shout_text }, message.shout_from !== 'sentinel').text;
  /** The page's facts about the items the shouts name: their title, the stage they stand at and where they open. */
  const itemById = new Map(p.items.map((entry) => [String(entry.id), entry]));
  const stageChip = (entry) => {
    if (!entry) return null;
    if (entry.status === 'withdrawn') return { tone: 'g', label: 'Withdrawn' };
    if (entry.status === 'open' && entry.verdict?.decision === 'REJECT') return { tone: 'sb', label: 'Sent back' };
    const word = stageOfItem(entry, p, gatedOf(entry)).stage;
    const pair = { Merged: ['l', 'Landed'], Landing: ['l', 'Landing'], Verified: ['l', 'Verified'], 'In review': ['r', 'In review'], Building: ['b', 'Building'], Ready: ['rd', 'Ready'], Blocked: ['wt', 'Waiting'] }[word] || ['g', word];
    return { tone: pair[0], label: pair[1] };
  };
  // Native pending-question lists are authoritative: answered or stale asks never keep a thread amber.
  const shoutById = new Map((unread ? heard : [...heard, ...questions]).map(x => [x.shout_id, x]));
  const plainShouts = [...shoutById.values()].map((x) => ({ id: x.shout_id, from: x.shout_from, to: x.shout_to, at: x.shout_at, model: x.shout_from === 'person' ? '' : modelOf(x.shout_from),
    ms: Date.parse(x.shout_at), text: messageText(x), decision: Boolean(x.shout_decision), answers: x.shout_answers || null, item: itemOf(x) ? String(itemOf(x)) : null }));
  const itemFacts = {};
  for (const shoutItem of new Set(plainShouts.map((x) => x.item).filter(Boolean))) {
    itemFacts[shoutItem] = { title: titles.get(shoutItem) || 'Item #' + shoutItem, chip: stageChip(itemById.get(shoutItem)), lane: itemById.get(shoutItem)?.lane || '', href: itemAddress(shoutItem, view.root) };
  }
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const seenMarks = shoutSeen(view.root);
  const buildShouts = () => shoutsModel({ messages: plainShouts, openIds: [...open], personAskIds: (p.decisions || []).map((d) => d.shout_id), queueAskIds: (p.decisionQueue || []).map((d) => d.shout_id),
    items: itemFacts, startOfToday, seen: seenMarks, filter: view.shoutFilter || 'all', openKey: view.shoutThread, foundId: view.shout, folded: Boolean(view.open.earlier) });
  let shoutModel = buildShouts();
  const openedThread = [...shoutModel.needs, ...shoutModel.threads, ...shoutModel.earlier.threads].find((thread) => thread.open);
  // Opening a thread reads it: the mark moves past what the thread holds, in this browser only.
  if (openedThread?.unread) { markShoutRead(view.root, openedThread.key); shoutModel = buildShouts(); }
  shoutOpenKey = openedThread?.key ?? null;
  shoutThreadIds = new Map([...shoutModel.needs, ...shoutModel.threads, ...shoutModel.earlier.threads].map((thread) => [thread.key, thread.messages.at(-1).id]));
  view.shoutCounts = shoutModel.counts;
  // The open thread's messages read in full with their item and code references live; the one-line rows stay plain text.
  const richById = {};
  for (const message of openedThread?.messages ?? []) {
    const original = shoutById.get(message.id);
    // Evidence a shout carries (B22), as the fields it is: its kind and outcome, the item, who sent it, and the commit, shortened, with the full SHA on hover.
    const receipt = original.shout_evidence_kind ? '<div class="receipt"><div><span class="badge">' + esc(original.shout_evidence_kind) + '</span> <span class="outcome">' + esc(original.shout_evidence_outcome) + '</span></div>'
      + '<div class="receipt-foot">' + linked('#' + original.shout_evidence_item, titles) + ' · ' + esc(agentName(original.shout_from)) + ' · ' + codeChip(String(original.shout_evidence_commit), 'sha') + '</div></div>' : '';
    richById[message.id] = rich(messageText(original), titles, true, view.root, true) + receipt + (original.options ? '<ol>' + original.options.map(option => '<li>' + esc(option) + '</li>').join('') + '</ol>' : '');
  }
  const missingAddress = view.shout !== null && !openedThread ? '<p class="empty" id="shout-address-status" role="status">' + esc(addressed?.error || 'Loading shout #' + view.shout + '…') + '</p>' : '';
  const replyFocus = document.activeElement?.matches?.('#feed [data-reply] input') ? document.activeElement.closest('[data-reply]').dataset.reply : null;
  const caret = replyFocus ? document.activeElement.selectionStart : null;
  const dayOf = (iso) => dateFormat('day', { month: 'short', day: 'numeric' }).format(new Date(iso));
  if (store.paint($('feed'), shoutsHtml(shoutModel, { clock, ago, day: dayOf, startOfToday, readOnly, rich: richById, full: [...openShouts], allMessages: Object.keys(view.open).filter((name) => name.startsWith('msgs:') && view.open[name]).map((name) => name.slice(5)), addressNote: missingAddress, bar }))) restoreShoutDrafts(replyFocus, caret);
  if (view.focusReply && openedThread) { view.focusReply = false; $('feed').querySelector?.('[data-reply] input')?.focus?.(); }
  // Keep legacy DOM anchors for older pages and automation; the decisions wall has no visible content.
  $('coordinator-decisions').hidden = true; $('coordinator-decisions').innerHTML = '';
  $('decisions').hidden = true; $('decisions').innerHTML = '';
  foldShouts();
  // Prepare agent, item-state and display observations before the pure selection and HTML functions.
  const panelNow = Date.now();
  const agentItems = items.map((item) => {
    const stale = staleChip(item);
    const state = stateOf(item);
    return { id: item.id, status: item.status, holder: holderOf(item), reviewer: reviewerOf(item), builtBy: item.builtBy,
      state, since: item.since, ageHtml: item.since ? '<time data-ago="' + esc(item.since) + '">' + ago(item.since) + '</time>' : '', stale: Boolean(stale), titleTextHtml: esc(item.title), titleHtml: rich(item.title, titles),
      stateHtml: stageMarkup(item, p, gatedOf(item), heldNote(item, p, undefined, panelNow) || '', itemStageMarks(item, p)),
      // The agent's row already names the agent, so its stage chip drops the "by <agent>" detail; hover still carries it.
      briefStateHtml: stageMarkup(item, p, gatedOf(item), heldNote(item, p, undefined, panelNow) || '', itemStageMarks(item, p), false, false, true) };
  });
  const agentRows = p.agents.map((agent) => {
    const isLead = lead(agent.agent_id);
    const letters = initials(agent.agent_id);
    return { agentId: agent.agent_id, name: agentName(agent.agent_id), nameHtml: esc(agent.agent_id), modelHtml: esc(modelOf(agent.agent_id)),
      lane: agent.agent_lane, route: agent.agent_route, path: agent.agent_path, lastMoveAt: agent.lastMoveAt,
      faceHtml: isLead ? '<span class="avatar">' + LEAD + '</span>' : '<span class="avatar' + (letters.length > 3 ? ' wide' : '') + '" aria-hidden="true">' + esc(letters) + '</span>',
      tipHtml: esc('Shouts with ' + agentName(agent.agent_id) + ' · ' + agent.agent_lane + ' · ' + agent.agent_route + ' (' + agent.agent_path + ')'),
      markClasses: ' h' + hue(agent.agent_id) + (isLead ? ' lead' : '') + (view.agent === agent.agent_id ? ' on' : ''),
      ageHtml: agent.lastMoveAt ? '<time data-ago="' + esc(agent.lastMoveAt) + '">' + ago(agent.lastMoveAt) + '</time>' : '' };
  });
  const panelSelection = agentsPanelModel({ agents: agentRows, items: agentItems, now: panelNow,
    activeAgent: view.agent, allAgents: view.allAgents, idleOpen: Boolean(view.open.idle) });
  if (panelSelection.idle.some((agent) => agent.agentId === view.agent)) view.open.idle = true;
  store.paint($('agents'), agentsPanelHtml({ ...panelSelection, idleOpen: Boolean(view.open.idle) }, { now: panelNow, dashboardHref: tabHref('dashboard') }));

  }

  if (draw && view.tab === 'spec') store.paint($('spec-fit'), (p.fit || []).length ? '<h3 class="hd2">Blueprint fit: ' + p.fit.length + ' unverified ' + (p.fit.length === 1 ? 'proposal' : 'proposals') + ' waiting for you</h3>' + p.fit.map(fitRow).join('') : '');
  for (const kind of ['spec', 'doctrine'].filter(kind => draw && kind === view.tab)) {
    const rows = kind === 'spec' ? p.spec : p.practice;
    const filter = view.rows[kind];
    const feedback = view.specFeedback?.kind === kind && view.specFeedback.root === view.root && view.specFeedback.from === 'list' ? view.specFeedback : null;
    const selectedRows = ruleListModel(rows, { kind, filter, selectedId: view.row[kind],
      addressed: view.tab === kind && view.addressDetail !== null, approvalIds: agentApprovals.map(row => row.id), feedback });
    const { labels, shorts, counts: n, shown: shownRows, feedbackId, sectionCounts, sectionReviewCounts, sectionKey } = selectedRows;
    const undecidedIds = new Set(selectedRows.undecidedIds);
    const undecided = row => undecidedIds.has(row.id);
    store.paint($(kind + '-chips'), segmentedToggle({ label: kind === 'spec' ? 'Spec rows' : 'Doctrine rows', attribute: 'data-rows', value: kind + ':' + filter, options: Object.keys(labels).map(key => ({ value: kind + ':' + key, label: labels[key], short: shorts[key], count: n[key], title: key === 'decide' ? selectedRows.decideTitle : undefined })) }));
    // With no row picked, or the pick filtered out, the detail opens on the first row shown, as Items does.
    view.row[kind] = selectedRows.nextSelectedId;
    let section = null;
    let listHtml = shownRows.length ? shownRows.map((r) => {
      const currentSection = kind === 'spec' ? r.section : sectionKey(r);
      const sectionCount = sectionCounts.get(currentSection);
      const standard = kind === 'doctrine' && r.origin === 'standard';
      const reviewNeeded = standard && ['pending', 'draft'].includes(r.status);
      const sectionName = standard ? 'PB · Pullboard rules' : r.section;
      const sectionAction = standard ? '<span class="doctrine-review-count">' + (sectionReviewCounts.get(currentSection) || 0) + ' to review</span>' : '';
      const head = currentSection !== section ? '<div class="spec-section-head doctrine-section-head"><h3 class="hd2">' + esc(sectionName) + ' <span class="section-count">' + sectionCount + '</span></h3>' + sectionAction + '</div>' : '';
      section = currentSection;
      const declined = kind === 'doctrine' && r.status === 'wont';
      const text = declined ? '<s>' + linked(r.standardText || r.text, titles) + '</s>' : linked(r.text, titles);
      const reason = (declined || kind === 'spec' && r.status === 'wont') && r.reason ? '<span class="rule-reason" title="' + esc(r.reason) + '">Reason: ' + linked(r.reason, titles) + '</span>' : '';
      const sourceLabel = standard ? '<span class="rule-source-chip standard" title="' + esc(ruleSourceTitle(r)) + '">Standard</span>' : '<span class="rule-source-chip repo" title="' + esc(ruleSourceTitle(r)) + '">This repo</span>';
      const secondary = (kind === 'doctrine' ? sourceLabel : '<span class="rule-source" title="this repo">this repo</span>') + reason + (kind === 'spec' ? specGateFiles(r) : doctrineCheck(r));
      const statusShown = filter === 'all' || !!r.staleDecision || (filter === 'decide' && r.status !== 'draft');
      const tierPill = r.tier ? '<span class="chip tier-pill tier-' + esc(r.tier) + '">' + esc(r.tier) + '</span>' : '';
      const itemCount = count(renderIndex(p).citations.get(r.id)?.length || 0, 'item', 'items');
      const badge = kind === 'spec' ? '<div class="spec-row-side">' + tierPill + '<small>' + itemCount + '</small></div>'
        : '<div class="spec-row-side">' + (reviewNeeded ? '<span class="chip warn tier-pill doctrine-review-chip">To review</span>' : tierPill)
          + ((renderIndex(p).citations.get(r.id)?.length || 0) ? '<small>' + itemCount + '</small>' : '') + '</div>';
      const citations = renderIndex(p).citations.get(r.id)?.length || 0;
      const iconHtml = kind === 'doctrine' && reviewNeeded ? '<svg class="doctrine-eye" viewBox="0 0 20 20" role="img" aria-label="To review"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z"/><circle cx="10" cy="10" r="2.5"/></svg>'
        : (r.status === 'approved' ? '✓' : r.status === 'wont' ? '×' : '✎');
      return head + (feedback && feedbackId === r.id ? specFeedback(feedback) : '') + recordRow({ tag: 'div', classes: 'spec-record ' + (reviewNeeded ? 'doctrine-standard-review ' : '') + (view.row[kind] === r.id ? 'on' : ''), attributes: 'data-row="' + kind + ':' + esc(r.id) + '"', title: r.text,
        iconHtml,
        state: reviewNeeded ? 'warn' : r.status === 'approved' ? 'verified' : r.status === 'wont' ? 'back' : 'open', primary: '<span class="row-id">' + esc(r.id) + '</span>' + text,
        secondary, rightTop: '', rightBottom: badge });
    }).join('') : '<div class="empty">' + (rows.length ? 'No rows match.' : kind === 'spec' ? 'No spec rows yet. Each requirement is one row in SPEC.md, such as G1 [draft, must] and a line; write them, or ask an agent to, and they show up here.' : 'No doctrine rows yet: they live in DOCTRINE.md.') + '</div>';
    if (feedback && !shownRows.length) listHtml += specFeedback(feedback);
    store.paint($(kind + '-list'), listHtml);
    const citedBy = (list, attrs) => {
      const link = item => '<div class="links-item spec-citing" ' + attrs + 'data-item="' + item.id + '"><span>#' + item.id + ' ' + rich(item.title, titles) + '</span></div>';
      if (!list.length) return 'No items yet';
      const rest = list.slice(5);
      return list.slice(0, 5).map(link).join('') + (rest.length ? '<details class="spec-more"><summary>' + rest.length + ' more</summary>' + rest.map(link).join('') + '</details>' : '');
    };
    const row = rows.find((r) => r.id === view.row[kind]);
    const citing = row ? renderIndex(p).citations.get(row.id) || [] : [];
    const declined = kind === 'doctrine' && row && row.status === 'wont';
    const text = row ? declined ? '<s>' + linked(row.standardText || row.text, titles) + '</s>' : linked(row.text, titles) : '';
    const standard = kind === 'doctrine' && row?.origin === 'standard';
    const reviewNeeded = standard && ['pending', 'draft'].includes(row.status);
    const source = kind === 'doctrine' && row ? '<span class="chip rule-source-chip ' + (standard ? 'standard' : 'repo') + '" title="' + esc(ruleSourceTitle(row)) + '">' + esc(ruleSource(row)) + '</span>' : '';
    const reason = (declined || kind === 'spec' && row?.status === 'wont') && row?.reason ? '<dt>reason</dt><dd>' + linked(row.reason, titles) + '</dd>' : '';
    // Only a standard rule gets a note; who approves rows is said once elsewhere, not in every detail (#822).
    const home = standard ? 'Standard rules come with Pullboard as defaults to review. Approve it to keep it, or override or decline it in DOCTRINE.md.' : '';
    const rowStatus = reviewNeeded ? 'To review' : row?.stage || row?.status;
    const agentApproval = kind === 'spec' && row ? agentApprovals.find(approval => approval.id === row.id) : null;
    const pendingQuestion = kind === 'spec' && row?.status === 'pending' && row.text.includes('. Choices: ') && row.text.endsWith('.');
    const rowDecisionActions = standard ? '' : pendingQuestion && !snapshot && (!readOnly || requests)
      ? '<form class="spec-answer-form" data-spec-answer="' + esc(row.id) + '"><label for="spec-answer-' + esc(row.id) + '">Answer</label><input id="spec-answer-' + esc(row.id) + '" name="answer" type="text" required autocomplete="off" placeholder="Your answer"><button class="approve-row" type="submit">Answer</button></form>'
      : agentApproval ? agentApprovalActions(agentApproval, true) : !snapshot && (!readOnly || requests) && row && undecided(row) && (kind === 'spec' || row.origin !== 'standard')
        ? '<div class="spec-decision-actions detail-decision-actions"><button class="approve-row" data-row-decision="approve" data-row-kind="' + kind + '" data-row-id="' + esc(row.id) + '" title="Approve (A, from the list)" type="button">Approve <kbd>A</kbd></button><button class="decline-row" data-row-decision="decline" data-row-kind="' + kind + '" data-row-id="' + esc(row.id) + '" title="Decline (D, from the list)" type="button">Decline <kbd>D</kbd></button></div>'
        : '';
    if (kind === 'spec' && row) {
      const change = !snapshot && (!readOnly || requests) ? '<button class="decline-row" type="button" data-row-change="' + esc(row.id) + '" title="Request a change through Shouts">Change</button>' : '';
      const actions = rowDecisionActions ? pendingQuestion ? rowDecisionActions + change : rowDecisionActions.replace('<button class="decline-row"', change + '<button class="decline-row"') : change;
      const draft = view.specDraft;
      store.paint($('spec-detail'), '<div class="spec-detail-content"><div class="spec-detail-section">' + esc(row.section) + '</div><h2><span class="row-id">' + esc(row.id) + '</span>' + text + '</h2><div class="meta"><span class="chip ' + tone(row.status) + '">' + esc(rowStatus.charAt(0).toUpperCase() + rowStatus.slice(1)) + '</span>' + (row.tier ? '<span class="chip tier-pill tier-' + esc(row.tier) + '">' + esc(row.tier) + '</span>' : '') + '</div>'
        + '<div class="spec-detail-actions">' + actions + '</div>' + (view.specFeedback?.root === view.root && view.specFeedback.kind === kind && view.specFeedback.id === row.id ? specFeedback(view.specFeedback) : '')
        + '<div class="spec-fact"><span>Proved by</span><div>' + (row.gate ? specGateFiles(row, true) : 'No gate yet') + '</div></div><div class="spec-fact"><span>Cited by</span><div class="links">' + citedBy(citing, 'role="button" tabindex="0" ') + '</div></div>'
        + (row.serves?.length ? '<div class="spec-fact"><span>Serves</span><div>' + esc(row.serves.join(', ')) + '</div></div>' : '')
        + (reason ? '<dl class="kv">' + reason + '</dl>' : '')
        + '<p class="spec-authority">Only you can decide a row.</p></div>');
      const restored = draft && document.getElementById(draft.id);
      if (restored && draft.value && !restored.value) { restored.value = draft.value; if (draft.focus) restored.focus(); }
      continue;
    }
    if (kind === 'doctrine' && row) {
      const hasFile = (row.gateFiles || []).some(gate => gate.exists === true);
      const facts = '<div class="spec-fact"><span>' + (hasFile ? 'Proved by' : 'Checked by') + '</span><div>' + doctrineCheck(row, true) + '</div></div>'
        + '<div class="spec-fact"><span>Cited by</span><div class="links">' + citedBy(citing, '') + '</div></div>';
      store.paint($('doctrine-detail'), '<div class="spec-detail-content doctrine-detail-content"><div class="spec-detail-section">' + esc(row.section) + '</div><h2><span class="row-id">' + esc(row.id) + '</span>' + text + '</h2><div class="meta"><span class="chip ' + (reviewNeeded ? 'warn' : tone(row.status)) + '">' + esc(rowStatus.charAt(0).toUpperCase() + rowStatus.slice(1)) + '</span>' + (row.tier ? '<span class="chip tier-pill tier-' + esc(row.tier) + '">' + esc(row.tier) + '</span>' : '') + source + '</div>'
        + (rowDecisionActions ? '<div class="spec-detail-actions">' + rowDecisionActions + '</div>' : '') + (home ? '<p class="doctrine-standard-note">' + esc(home) + '</p>' : '')
        + facts + (reason ? '<dl class="kv">' + reason + '</dl>' : '') + (row.serves?.length ? '<div class="spec-fact"><span>Serves</span><div>' + esc(row.serves.join(', ')) + '</div></div>' : '')
        + '<p class="spec-authority">Only you can decide a row.</p></div>');
      continue;
    }
    store.paint($(kind + '-detail'), row ? '<div class="stack tight"><h2><span>' + esc(row.id) + '</span>' + text + '</h2><div class="meta"><span class="chip ' + tone(row.status) + '">' + esc(rowStatus) + '</span>' + (row.tier ? '<span class="chip">' + esc(row.tier) + '</span>' : '') + source + '</div>' + rowDecisionActions + (kind === 'spec' && view.specFeedback?.kind === kind && view.specFeedback.root === view.root && view.specFeedback.from === 'detail' && view.specFeedback.id === row.id ? specFeedback(view.specFeedback) : '') + '<dl class="kv"><dt>section</dt><dd>' + esc(row.section) + '</dd>' + reason + (row.gate ? '<dt>gate</dt><dd>' + esc(row.gate) + '</dd>' : '') + (row.serves && row.serves.length ? '<dt>serves</dt><dd>' + esc(row.serves.join(', ')) + '</dd>' : '') + '</dl><div><h3 class="hd2">Items that cite it</h3>' + (citing.length ? '<div class="links">' + citing.map((i) => '<div class="links-item" data-item="' + i.id + '"><span>#' + i.id + ' ' + rich(i.title, titles) + '</span></div>').join('') + '</div>' : '<div class="muted">None yet.</div>') + '</div>' + (home ? '<div class="muted">' + home + '</div>' : '') + '</div>' : '<div class="empty">' + (view.tab === kind && view.addressDetail !== null ? 'No ' + (kind === 'spec' ? 'Spec' : 'Doctrine') + ' row ' + esc(view.addressDetail) + ' exists here.' : 'Pick a row to see it, and the items that cite it.') + '</div>');
  }

  // The Lanes fold and its hold form sit on Activity, so Activity draws them: drawn with Shouts, a release or hold made there never repainted (#10661).
  if (draw && view.tab === 'activity') {
    if ($('hold-lane').dataset.lanes !== working.join()) {
      $('hold-lane').dataset.lanes = working.join();
      $('hold-lane').innerHTML = working.map(lane => '<option>' + esc(lane) + '</option>').join('');
    }
    const held = new Map(p.holds.map((h) => [h.hold_lane, h]));
    if (held.size && $('lanes-fold')) $('lanes-fold').open = true;
    store.paint($('lanes'), working.map((l) => '<div class="lane"><span><b>' + esc(l) + '</b> ' + (held.has(l) ? '<span class="chip no" title="held by ' + esc(agentName(held.get(l).hold_by)) + '">held by ' + esc(agentName(held.get(l).hold_by)) + '</span> <span class="muted">' + linked(held.get(l).hold_reason, titles) + '</span>' : '<span class="chip ok">open</span>') + '</span>' + (held.has(l) ? '<button class="ghost" data-release="' + esc(l) + '" type="button">Release</button>' : '') + '</div>').join(''));
    activityView.draw(p, switching);
  }
  if (draw && !roadmapBehind) store.paneDrawn(view.tab, store.paneKey(view, $('q').value));
  showTab();
  drawPageControls();
  revealPlace();
  revealSegmentedChoices(document);
  updateRoadmapPanel();
  drawHistoryNotes();
  store.scrollRestore(scrolled);
}
`;
}
