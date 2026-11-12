/** Render only the selected board pane while preserving shared navigation and status [N26]. */
import { needsActionsHtml } from "../../logic/needs/actions.js";
import { needsPanelHtml } from "../../logic/needs/panel.js";
import { agentsPanelModel } from "../../logic/panel/model.js";
import { agentsPanelHtml } from "../../logic/panel/render.js";
import { needsPanelModel } from "../../logic/needs/panel.js";
import { LEAKS } from "../../logic/needs/list.js";
import { PLAIN_FALLBACK } from "../../logic/needs/list.js";
import { plainNeedWords } from "../../logic/needs/list.js";
import { ruleListModel } from "../../logic/rules.js";
import { selectItemsView } from "../../logic/selection.js";
import { overlapHtml } from "../../logic/overlap.js";

/** Return the shared browser-scope renderer without eagerly building hidden pane DOM. */
export function pageRenderScript() {
  return `let drawnRoadmap = null;
const agentsPanelModel = (${agentsPanelModel.toString()});
const agentsPanelHtml = (${agentsPanelHtml.toString()});
const ruleListModel = (${ruleListModel.toString()});
const selectItemsView = (${selectItemsView.toString()});
const overlapHtml = (${overlapHtml.toString()});
const PLAIN_FALLBACK = (${JSON.stringify(PLAIN_FALLBACK)});
const LEAKS = [${LEAKS.map(String).join(",")}];
const plainNeedWords = (${plainNeedWords.toString()});
const needsPanelModel = (${needsPanelModel.toString()});
const needsActionsHtml = (${needsActionsHtml.toString()});

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
function stageMarkup(item, project = {}, gated = false, gateDetail = '', marks = [], compact = false) {
  const stage = stageOfItem(item, project, gated, gateDetail);
  return '<span class="item-stage" data-stage="' + esc(itemStageKey(stage.stage)) + '" role="group" title="' + esc(stage.detail) + '" aria-label="' + esc(stage.stage + ': ' + stage.detail) + '"><span class="stage-line">' + (compact ? '<span class="chip item-status ' + esc(stateOf(item)) + '">' : '') + '<b class="stage-word">' + esc(stage.stage) + '</b>' + (compact ? '</span>' : '')
    + (marks.length ? '<span class="stage-marks">' + marks.join('') + '</span>' : '') + '</span><small class="stage-detail" title="' + esc(stage.detail) + '">' + esc(stage.detail) + '</small></span>';
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

function render() {
  renderIndexes = new WeakMap();
  // A refresh that moved the page to another board closes a confirmation opened on the last one.
  closeIfLeft();
  if (heldClickPointer !== null || pageDialogs.size) { deferredClickRender = true; return; }
  deferredClickRender = false;
  const statsFocus = document.activeElement?.id === 'proof-stats-summary' ? document.activeElement.id : null;
  const p = privateModelProject(data.project);
  const group = data.group;
  renderSide();
  // A list that names a board no read has answered yet is still loading, never a machine without boards (#1035).
  const listing = !p && !group && data.projects.some((entry) => entry.ok);
  $('project-loading').hidden = data.root === view.root && !listing;
  if (data.root !== view.root || listing) {
    // Keep the cached picker available, but never label the last board's counts as the new one.
    document.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = true; });
    for (const id of ['products', 'group-view', 'proof-stats', 'upgrade-note', 'person-requests', 'credentials', 'find-results']) $(id).hidden = true;
    $('status-board').innerHTML = '';
    $('live').textContent = 'Loading project…';
    return;
  }
  $('proof-stats').hidden = true;
  $('proof-stats').innerHTML = '';
  if (view.answering && view.answering.root !== view.root) answer(null);
  // Until the first board arrives the page shows no tabs or panes, so a machine with none never
  // flashes them; with no board to show, one message says how a board starts, in their place.
  document.body.classList.remove('loading');
  document.body.classList.toggle('boardless', !p && !group);
  $('group-view').hidden = !group;
  $('tabs').hidden = Boolean(group);
  document.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = Boolean(group) || pane.dataset.pane !== view.tab; });
  $('products').hidden = !p || !p.products.length;
  renderReleaseNotes(group ? null : p);
  renderHostedReleaseNote(p);
  renderPersonRequests(p);
  renderCredentials();
  // A board's Settings pane still refreshes the shared status counts; machine-only Settings has no board to render.
  if (view.tab === 'settings' && !p) { $('group-view').hidden = true; showTab(); return; }
  if (group) { renderGroup(group); return; }
  if (!p) return;
  $('proof-stats').hidden = view.tab !== 'items';
  if (view.tab === 'items') $('proof-stats').innerHTML = proofStatsCard(p.proofStats, view.statsOpen);
  // Polling replaces this card's controls; keep the person's keyboard position through that redraw.
  if (statsFocus && view.tab === 'items') $(statsFocus)?.focus({ preventScroll: true });
  // Each product's progress (N28): the rows an accepted item cites, and its items by state.
  $('prod-list').innerHTML = p.products.map((x) => {
    const states = [['open', '', x.items.open], ['building', 'building', x.items.claimed], ['to verify', 'verify', x.items.submitted], ['verified', 'verified', x.items.verified]].filter(([, , n]) => n);
    return '<div class="prod" title="' + x.rows + ' rows in force, ' + x.approved + ' approved, ' + x.proven + ' cited by accepted items"><p><b>' + esc(x.name) + '</b><span>' + x.proven + '/' + x.rows + ' rows met</span></p><svg class="bar" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><rect width="' + (x.rows ? Math.round((100 * x.proven) / x.rows) : 0) + '" height="1"/></svg>'
      + (states.length ? '<small>' + states.map(([label, dot, n]) => '<span><i class="dot ' + dot + '"></i>' + n + ' ' + label + '</span>').join('') + '</small>' : '') + '</div>';
  }).join('');
  const items = p.items.filter((i) => i.status !== 'withdrawn');
  const active = items.filter((i) => stateOf(i) !== 'verified');
  const titles = renderIndex(p).titles;
  const lanes = p.lanes, working = lanes.filter((lane) => lane !== 'coordinator');
  const heldLanes = new Map(p.holds.map((hold) => [hold.hold_lane, hold]));
  const gatedOf = (item) => item.status === 'open' && (item.blockedBy.length > 0 || heldLanes.has(item.lane) || (p.itemHolds || []).some((hold) => hold.item === item.id));
  if (view.tab === 'cost' && privateCost && !snapshot && !hosted.local && !readOnly && !data.group) {
    const history = readCostHistory(p);
    $('cost').innerHTML = costPaneHtml(history, p);
  }
  if (view.tab === 'roadmap') {
  // Every refresh redraws the Roadmap. Left alone, that would send the phone's release chips back to their start
  // and the panel back to its top under a person mid-scroll, so both keep where they were.
  const chipsAt = $('roadmap-releases')?.scrollLeft ?? 0, panelAt = $('roadmap-panel')?.scrollTop ?? 0;
  roadmapAhead.clear();
  roadmapDetails.clear();
  const roadmap = roadmapCards(p, titles), roadmapHtml = roadmap.html;
  const roadmapBoard = p.board ?? data.projects.find(project => project.root === view.root)?.id ?? null;
  if (drawnRoadmap?.root !== view.root || drawnRoadmap.board !== roadmapBoard || drawnRoadmap.html !== roadmapHtml) {
    $('roadmap').innerHTML = roadmapHtml;
    drawnRoadmap = { root: view.root, board: roadmapBoard, html: roadmapHtml };
  }
  restoreRoadmapArrival();
  // The mark sets its chip in bold, which widens it, and the fresh row has no mark yet. Restored first, the scroll
  // would clamp to a row narrower by that bold and leave the chips short of where they were (#452).
  if ($('roadmap-releases')) $('roadmap-releases').scrollLeft = chipsAt;
  if ($('roadmap-panel')) $('roadmap-panel').scrollTop = panelAt;

  }

  // What needs the person, first, and only the person's calls (B26): the decisions passed up to them,
  // questions in the spec, held lanes, then draft rows. Work waiting for a verdict or sent back shows
  // on the board with who holds it; it is the agents' to move.
  const needsTab = ['items', 'dashboard'].includes(view.tab);
  const needsProject = { ...p, agents: (p.agents || []).map(agent => ({ ...agent, displayName: agentName(agent.agent_id, p) })) };
  const personalNeeds = needsTab || ['spec', 'doctrine'].includes(view.tab) ? personNeeds(needsProject) : [];
  const agentApprovals = personalNeeds.filter(row => row.kind === 'agent-approved');
  if (needsTab) {
  const person = !snapshot && (!readOnly || requests);
  const expandedNeeds = [...document.querySelectorAll('details[data-needs-key][open]')].filter(entry => !entry.closest('[hidden]')).map(entry => entry.dataset.needsKey);
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
  const needsModel = needsPanelModel(personalNeeds,p,{ person, expanded: expandedNeeds });
  // Browser-dependent presentation is prepared from the same descriptors the pure renderer consumes.
  const needsPresentation = new Map([...needsModel.questions,...needsModel.approvals].map(row => {
    const approvedAt = row.fields.find(([label]) => label === 'Approved in Git')?.[3]?.date;
    return [row.key, {
      ageHtml: row.ageAt ? age(row.ageAt) : '', bodyHtml: row.body ? rich(row.body,titles,!readOnly) : '',
      feedbackHtml: needsFeedback(row.source), controlsHtml: needsControls(row.source),
      approvalDateLabel: Number.isFinite(Date.parse(approvedAt)) ? approvalDateLabel(approvedAt) : 'Date unknown',
    }];
  }));
  const needsPanel = ${needsPanelHtml.toString()};
  if (view.tab === 'dashboard') {
    const dashboardNeeds = needsPanelModel(personalNeeds,p,{ person, expanded: expandedNeeds, compact: true });
    dashboardView.draw(p, needsPanel({...dashboardNeeds,headerSeparately:true},needsPresentation), {
      needsHeader: needsPanel({...dashboardNeeds,headerOnly:true},needsPresentation),
      rules: homeRules(p.spec),
      capacity: homeCapacity(p.capacityForecast),
    });
  } else {
    const needsHtml = needsPanel(needsModel,needsPresentation);
    if (view.tab === 'items') {
      $('needs').hidden = !personalNeeds.length || view.state !== 'active' || Boolean(view.lane);
      $('needs').tabIndex = -1;
      $('needs').innerHTML = needsHtml;
    }
  }
  }

  if (view.tab === 'items') {
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
  $('items-view-switch').innerHTML = segmentedToggle({ label: 'Items view', attribute: 'data-items-view', value: view.itemsView, options: [{ value: 'list', label: 'List' }, { value: 'pipeline', label: 'Pipeline' }] });
  $('item-list').hidden = pipeline;
  $('pipeline').hidden = !pipeline;
  // Each Show choice counts what it would show under the lane and the search. A search looks through every
  // state, withdrawn items included; browsing leaves those out.
  const found = searchIds(p, q);
  // Gated is shared by the rows, filter and status bar. Capture all clocks/derived state here;
  // the pure selector receives observations and ids, never the page's data/view globals.
  const readyIds = dashboardModel(p, [], { complete: false, now: Date.now() }).next.map(item => item.id);
  const stateById = new Map(p.items.map(item => [item.id, { state: stateOf(item), gated: gatedOf(item) }]));
  const itemsSelection = selectItemsView({ items: p.items, query: q, matchedIds: found, readyIds, stateById, state: view.state,
    lane: view.lane, pipeline, dashboardList: view.dashboardList, dashboardNext: p.dashboardNext || [], selectedId: view.item,
    currentBoard: data.root === view.root, adding: view.adding,
    addressDetail: view.tab === 'items' ? view.addressDetail : null, tab: view.tab, snapshot });
  view.lane = itemsSelection.selectedLane;
  const { matching, stateOptions, laneOptions, inView, shown, finishedUnderAll } = itemsSelection;
  const stateButtons = stateOptions.map(({ value, label, count }) => '<button class="filter-option" role="menuitemradio" aria-checked="' + (view.state === value) + '" data-filter-choice="state:' + value + '" data-filter-kind="state" data-filter-value="' + value + '" data-state="' + value + '" type="button"><span class="filter-option-label">' + label + '</span><b>' + count + '</b></button>');
  const laneButtons = laneOptions.map(({ value, label, count }) => '<button class="filter-option" role="menuitemradio" aria-checked="' + ((view.lane || '') === value) + '" data-filter-choice="lane:' + esc(value) + '" data-filter-kind="lane" data-filter-value="' + esc(value) + '" aria-label="' + esc(label) + (count === null ? '' : ' · ' + count) + '" title="' + esc(label) + (count === null ? '' : ' · ' + count) + '" type="button"><span class="filter-option-label">' + esc(label) + '</span>' + (count === null ? '' : '<b>' + count + '</b>') + '</button>');
  const activeChoice = document.activeElement?.dataset?.filterChoice;
  const menu = $('filter-menu');
  menu.innerHTML = (pipeline ? '' : '<section class="filter-group" role="group" aria-label="Show"><h3>Show</h3>' + stateButtons.join('') + '</section>')
    + '<section class="filter-group" role="group" aria-label="Lane"><h3>Lane</h3>' + laneButtons.join('') + '</section>';
  menu.hidden = !view.filterOpen;
  menu.style.left = '0px';
  menu.style.maxWidth = '';
  if (view.filterOpen) {
    // The open menu stays inside the toolbar, no wider than it and shifted left as far as it needs. The window's
    // width is no measure of that room: it counts a classic scrollbar, so on CI's runners a menu kept inside the
    // window still reached 10px past the toolbar (#442).
    const bar = $('items-toolbar'), box = bar.getBoundingClientRect(), left = box.left + bar.clientLeft, right = left + bar.clientWidth;
    menu.style.maxWidth = Math.min(320, bar.clientWidth) + 'px';
    const at = menu.getBoundingClientRect();
    menu.style.left = Math.max(left - at.left, Math.min(0, right - at.right)) + 'px';
  }
  $('filter-toggle').setAttribute('aria-expanded', String(view.filterOpen));
  const filterLabel = itemsSelection.filterLabel;
  $('filter-label').textContent = filterLabel;
  $('filter-toggle').setAttribute('aria-label', filterLabel);
  $('filter-toggle').title = filterLabel;
  if (view.filterOpen && activeChoice) [...menu.querySelectorAll('[data-filter-choice]')].find((option) => option.dataset.filterChoice === activeChoice)?.focus({ preventScroll: true });
  $('pipeline').innerHTML = pipeline ? pipelineCard(shown) : '';
  const { nextSelectedId } = itemsSelection;
  if (nextSelectedId !== view.item) view.item = nextSelectedId;
  // With nothing picked, the detail shows the first row, and keeps it when a refresh reorders the list.
  // While another project loads, the item picked there waits for its own board.

  $('chain').innerHTML = shown.length ? shown.map((i) => {
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
  }).join('') : '<li class="empty">' + (finishedUnderAll
    ? 'Finished work is under All. <button class="link" data-filter-choice="state:all" data-filter-kind="state" data-filter-value="all" type="button">Show all</button>'
    : items.length ? 'No items match.' : snapshot ? 'No items at this event.' : 'No items yet. Add the first one with New item.') + '</li>';

  const selected = p.items.find((i) => i.id === view.item);
  // The form shows when asked for, or when the project has no item at all, withdrawn ones included.
  const adding = view.adding || (!p.items.length && !(view.tab === 'items' && view.addressDetail !== null && view.addressDetail !== 'pipeline'));
  $('add-form').hidden = !adding;
  $('add-cancel').hidden = !p.items.length;
  $('detail').hidden = adding;
  if (!selected) $('detail').innerHTML = '<div class="empty">' + (view.tab === 'items' && view.addressDetail !== null && view.addressDetail !== 'pipeline' ? 'No item #' + esc(view.addressDetail) + ' exists here.' : 'Pick an item to see its criterion, verdicts and history.') + '</div>';
  const opened = selected && !view.adding ? detailOf(p, selected, view.tab === 'items' && data.root === view.root) : null;
  /** An item's heading: its id, title, state, lane and route, all of which its summary holds. */
  const head = (item, s = stateOf(item)) => '<div><h2><span>#' + item.id + '</span>' + rich(item.title, titles) + '</h2><div class="meta spaced">' + stageMarkup(item, p, gatedOf(item), heldNote(item, p, undefined, Date.now()) || '', itemStageMarks(item, p)) + '<span class="chip">' + esc(item.lane) + '</span><span class="chip">' + esc(item.route) + '</span></div></div>';
  if (opened?.error) $('detail').innerHTML = '<div class="stack"><p class="detail-wait muted" role="status">Could not load #' + selected.id + ': ' + esc(opened.error) + '</p></div>';
  // Until its omitted fields arrive, an opened item paints its heading from its summary and fills the rest in place (#1039).
  else if (opened?.loading) $('detail').innerHTML = '<div class="stack" aria-busy="true">' + head(selected) + '</div>';
  const item = opened?.item;
  if (item) {
    const s = stateOf(item);
    const cited = item.specs.map((id) => p.spec.find((r) => r.id === id) || { id, status: 'missing', text: '(not in SPEC.md)' });
    const baseline = item.checkBaseline;
    const baselineClass = baseline?.result === 'green' ? 'ok' : baseline?.result === 'red' ? 'no' : baseline?.result === 'pending' ? 'warn' : '';
    /** Render the item's lane, route and current milestone in the approved plain header. */
    const where = [item.lane, item.route, (p.milestones || []).find(milestone => milestone.items?.some(entry => entry.id === item.id))?.name].filter(Boolean);
    /** Parse a single named test case only from the recorded check or its baseline evidence. */
    const namedCase = (() => {
      const pattern = /--test-name-pattern(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s;]+))/u.exec(item.check || '');
      if (pattern) return pattern[1] || pattern[2] || pattern[3];
      const evidence = [...(baseline?.testEvidence?.failed || []), ...(baseline?.testEvidence?.passed || [])].filter(name => typeof name === 'string');
      const names = [...new Set(evidence)];
      return names.length === 1 ? names[0] : '';
    })();
    /** Turn the check into the approved sentence without inventing an unnamed case. */
    const checkSentence = (() => {
      const command = String(item.check || '');
      const testPath = /(?:^|\\s)((?:[\\w.-]+\\/)*[\\w.-]+\\.test\\.[cm]?js)\\b/u.exec(command)?.[1];
      if (testPath && /(?:^|\\s)(?:bin\\/run-tests\\.js|packages\\/gate\\/src\\/io\\/run\\/tests\\.js)(?:\\s|$)/u.test(command)) {
        return 'Passes when <span class="file"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M6 2.5h4M7 2.5v4L3.5 12.5a1 1 0 0 0 .9 1.5h7.2a1 1 0 0 0 .9-1.5L9 6.5v-4"/></svg>' + esc(testPath) + '</span> runs with no failures' + (namedCase ? ' and its case <i>"' + esc(namedCase) + '"</i> passes' : '') + '.';
      }
      return command ? 'Runs: <code>' + esc(command) + '</code>' : 'No check is recorded.';
    })();
    /** Remove the Files section from prose because its paths are rendered as chips below. */
    const briefCopy = (() => {
      let inFiles = false;
      return String(item.brief || '').split(/\\r?\\n/u).filter(line => {
        const label = /^(files|change|test|out of scope|reference)\\s*:/iu.exec(line.trim());
        if (label) { inFiles = label[1].toLowerCase() === 'files'; return !inFiles; }
        return !inFiles;
      }).join('\\n').trim();
    })();
    /** Keep the brief's declared paths visible, grouped into source and test counts. */
    const files = panelFiles(item.brief || '');
    /** Render one path with a subdued directory and its file or test glyph. */
    const fileChip = path => {
      const slash = path.lastIndexOf('/'), testFile = /^(?:test|tests)\\//u.test(path);
      return '<span class="file item-file" data-file="' + esc(path) + '"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="' + (testFile ? 'M6 2.5h4M7 2.5v4L3.5 12.5a1 1 0 0 0 .9 1.5h7.2a1 1 0 0 0 .9-1.5L9 6.5v-4' : 'M4 2h5l3 3v9H4zM9 2v3h3') + '"/></svg><span><span class="dir">' + esc(slash < 0 ? '' : path.slice(0, slash + 1)) + '</span>' + esc(slash < 0 ? path : path.slice(slash + 1)) + '</span></span>';
    };
    const sourceCount = files.filter(path => !/^(?:test|tests)\\//u.test(path)).length;
    const testCount = files.length - sourceCount;
    const historyEntries = (item.thread?.length ? item.thread : item.history || []).filter(entry => !['usage', 'shared-usage'].includes(entry.kind));
    const historyCount = historyEntries.length;
    const verdicts = item.verdicts || [];
    const passedCount = verdicts.filter(verdict => verdict.decision === 'ACCEPT').length;
    const backCount = verdicts.length - passedCount;
    const panelChoice = view.itemPanel?.root === view.root && view.itemPanel.item === item.id ? view.itemPanel.tab : 'overview';
    const statusChips = stageMarkup(item, p, gatedOf(item), heldNote(item, p, undefined, Date.now()) || '', itemStageMarks(item, p))
      + (verdicts.some(verdict => verdict.decision === 'REJECT') && ['building', 'verify', 'verified'].includes(s) ? '<span class="chip">Resubmitted after a send-back</span>' : '')
      + overlapHtml(data.claimOverlaps, item.id)
      + (item.builtBy ? '<span class="chip">Built by ' + esc(agentName(item.builtBy)) + '</span>' : '')
      + (item.commit ? '<span class="item-head-hash">at ' + hashButton(item.commit) + '</span>' : '');
    const factRefs = (item.thread || []).filter((entry) => entry.type === 'fact' && entry.ref);
    const referencedCode = factRefs.length ? '<div><h3>Referenced code</h3>' + factRefs.map((fact) => {
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
    }).join('') + '</div>' : '';
    /** Render one verdict as the existing shared row, with its complete note in the disclosure. */
    const verdictRows = verdicts.toReversed().map(verdict => {
      const passed = verdict.decision === 'ACCEPT';
      const note = visibleVerdictNote(verdict.reason, verdict.note);
      const first = note.split(/\\r?\\n/u, 1)[0];
      const summary = first.length > 180 ? first.slice(0, 177) + '…' : first;
      const state = passed ? 'verified' : 'back';
      const iconPath = passed ? 'M3.5 8.5l3 3 6-6.5' : 'M6 4 2.5 7.5 6 11M2.5 7.5H10';
      const title = passed ? 'Passed' : 'Sent back · ' + activityWords({ cause: verdict.reason }).label;
      return sharedRowHtml({ tag: 'li', variant: 'item', state, title: title + ' by ' + agentName(verdict.by),
        iconHtml: '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + iconPath + '"/></svg>',
        primaryHtml: '<b>' + (passed ? 'Passed' : 'Sent back · ' + reasonHtml(verdict.reason)) + '</b> <span class="muted">by ' + esc(agentName(verdict.by)) + '</span>',
        timeHtml: '<time>' + esc(when(verdict.at)) + '</time>', metaHtml: '<span class="item-verdict-note">' + inline(summary, titles) + '</span>',
        detailHtml: '<div class="verdict ' + (passed ? 'yes' : 'no') + '"><b>' + (passed ? 'Accepted · <span title="' + esc(verdict.reason) + '">' + esc(activityWords({ cause: verdict.reason }).label) + '</span>' : 'Sent back · ' + reasonHtml(verdict.reason)) + '</b><span class="by">' + esc(agentName(verdict.by)) + ' · ' + esc(when(verdict.at)) + (verdict.commit ? ' · at ' + hashButton(verdict.commit) : '') + '</span><div class="note">' + inline(note, titles) + '</div></div>' });
    }).join('');
    /** Keep the established verdict renderer's reason, timestamp and copyable SHA in the new card. */
    const latest = item.verdict ? '<div class="item-panel-latest' + (item.verdict.decision === 'REJECT' ? ' sentback' : '') + '"><div class="verdict ' + (item.verdict.decision === 'ACCEPT' ? 'yes' : 'no') + '"><b class="item-panel-verdict-label">' + (item.verdict.decision === 'ACCEPT' ? 'Passed' : 'Sent back · ' + reasonHtml(item.verdict.reason)) + '</b><span class="by">' + esc(agentName(item.verdict.by)) + ' · ' + esc(when(item.verdict.at)) + (item.verdict.commit ? ' · at ' + hashButton(item.verdict.commit) : '') + '</span><div class="note">' + inline(visibleVerdictNote(item.verdict.reason, item.verdict.note), titles) + '</div></div><button class="link" type="button" data-item-panel-more>Show all</button></div>' : '<p class="muted">No verdict yet.</p>';
    const baselineLabel = baseline?.result === 'red' ? 'Red on main' : baseline?.result === 'green' ? 'Green on main' : baseline?.result === 'pending' ? 'Pending on main' : 'No baseline';
    const baselineReason = baseline?.result === 'red' ? 'as it should be: the check fails before the change'
      : baseline?.result === 'green' ? 'the check passed on main before this change'
        : baseline?.result === 'pending' ? 'the check has not finished on main' : 'no result was recorded on main before this change';
    const check = '<div class="item-panel-check"><span class="item-panel-check-mark" aria-hidden="true"><svg viewBox="0 0 16 16\"><path d="M3.5 8.5l3 3 6-6.5\"/></svg></span><div><p>' + checkSentence + '</p>'
      + '<div class="item-panel-baseline"><span class="chip ' + baselineClass + '">' + baselineLabel + '</span><span>' + baselineReason + '</span></div>'
      + (baseline?.warning === 'CRITERION_PROVES_NOTHING' ? '<p class="check-warning">This check already passed before the work, so it proves nothing.</p>' : '')
      + (item.check ? '<details class="item-panel-command"><summary>Show the command</summary><pre>' + esc(item.check) + '</pre></details>' : '') + '</div></div>';
    const historyOpen = view.historyOpen?.has(JSON.stringify([view.root, view.item])) === true;
    const moreHistory = historyCount > 5 ? '<button class="link item-panel-history-more" type="button" data-item-panel-history data-count="' + historyCount + '" aria-expanded="' + historyOpen + '">' + (historyOpen ? 'Show less' : 'Show all ' + historyCount) + '</button>' : '';
    /** Render one accessible tab with the selected tab's native count. */
    const panelTab = (id, label, count) => '<button type="button" role="tab" id="item-panel-tab-' + id + '" aria-controls="item-panel-panel-' + id + '" aria-selected="' + (panelChoice === id) + '" data-item-panel-tab="' + id + '"' + (panelChoice === id ? ' class="on"' : '') + '>' + label + (count === null ? '' : ' <b>' + count + '</b>') + '<span class="seg-hit seg-hit-top" aria-hidden="true"></span><span class="seg-hit seg-hit-bottom" aria-hidden="true"></span></button>';
    $('detail').innerHTML = '<div class="item-panel"><header class="item-panel-head"><div class="item-panel-where">' + where.map((part, index) => (index ? '<span class="sep">·</span>' : '') + '<span>' + esc(part) + '</span>').join('') + '</div><h2><span class="id">#' + item.id + '</span>' + rich(item.title, titles) + '</h2><div class="item-panel-status">' + statusChips + '</div></header>'
      + '<div class="seg item-panel-tabs" role="tablist" aria-label="Item details">' + panelTab('overview', 'Overview', null) + panelTab('verdicts', 'Verdicts', verdicts.length) + panelTab('history', 'History', historyCount) + '</div>'
      + '<section class="item-panel-section" id="item-panel-panel-overview" role="tabpanel" aria-labelledby="item-panel-tab-overview"' + (panelChoice === 'overview' ? '' : ' hidden') + ' data-item-panel-panel="overview">'
      + '<div class="item-panel-section-head"><p class="label">Latest verdict</p><span class="item-panel-count">Passed ' + passedCount + ' ' + (passedCount === 1 ? 'time' : 'times') + ' · sent back ' + backCount + '</span></div>' + latest
      + (item.criterion ? '<section class="item-panel-block"><h3>Done when</h3><div class="item-panel-expand"><div class="item-panel-expand-text item-panel-clamp">' + rich(item.criterion, titles) + '</div><button class="link" type="button" data-item-panel-more>Show all</button></div></section>' : '')
      + (item.check ? '<section class="item-panel-block"><h3>Check</h3>' + check + '</section>' : '')
      + (item.brief ? '<section class="item-panel-block"><div class="item-panel-section-head"><h3>Brief</h3><span class="item-panel-count">' + files.length + ' files: ' + sourceCount + ' source, ' + testCount + ' tests</span></div>' + (briefCopy ? '<div class="item-panel-brief">' + rich(briefCopy, titles) + '</div>' : '') + (files.length ? '<div class="item-panel-files">' + files.map(fileChip).join('') + '</div>' : '') + '</section>' : '')
      + referencedCode
      + (cited.length ? '<section class="item-panel-block"><h3>Spec rows it serves</h3>' + cited.map(r => '<div class="rowref"><code>' + esc(r.id) + '</code><div>' + linked(r.text, titles) + ' <span class="chip ' + tone(r.status) + '">' + esc(r.status) + '</span></div></div>').join('') + '</section>' : '')
      + (item.owner && s === 'building' || item.verifiedBy || item.merged || item.blockedBy.length ? '<section class="item-panel-block"><h3>Work details</h3><dl class="kv">' + (item.owner && s === 'building' ? '<dt>holding</dt><dd>' + esc(agentName(item.owner)) + '</dd>' : '') + (item.verifiedBy ? '<dt>verified by</dt><dd>' + esc(agentName(item.verifiedBy)) + '</dd>' : '') + (item.merged ? '<dt>merged</dt><dd>' + hashButton(item.merged) + '</dd>' : '') + (item.blockedBy.length ? '<dt>waits on</dt><dd class="waits-on">' + item.blockedBy.map(id => '<span class="wait-unit"><a class="ref" href="' + esc(itemAddress(id)) + '" data-go="item:' + id + '">#' + id + '</a></span>').join(', ') + '</dd>' : '') + '</dl></section>' : '')
      + '</section><section class="item-panel-section item-panel-verdicts" id="item-panel-panel-verdicts" role="tabpanel" aria-labelledby="item-panel-tab-verdicts"' + (panelChoice === 'verdicts' ? '' : ' hidden') + ' data-item-panel-panel="verdicts">' + (verdictRows || '<p class="muted">No verdicts yet.</p>') + '</section>'
      + '<section class="item-panel-section item-panel-history" id="item-panel-panel-history" role="tabpanel" aria-labelledby="item-panel-tab-history"' + (panelChoice === 'history' ? '' : ' hidden') + ' data-item-panel-panel="history">' + moreHistory + '<div class="item-panel-history-list' + (historyCount > 5 ? ' folded' : '') + (historyCount > 5 && historyOpen ? ' expanded' : '') + '">' + timeline(item, { newestFirst: true }) + '</div></section>'
      + '<div class="links"><button class="ghost" data-shout="' + esc(item.lane) + '" data-about="' + item.id + '" type="button">Shout the ' + esc(item.lane) + ' lane about #' + item.id + '</button><button class="go" data-new type="button">New item</button></div></div>';
  }

  }

  if (view.tab === 'shouts') {
  if ($('hold-lane').dataset.lanes !== working.join()) {
    $('hold-lane').dataset.lanes = working.join();
    $('hold-lane').innerHTML = working.map(lane => '<option>' + esc(lane) + '</option>').join('');
  }
  // Every #id in a shout that names an item opens it, whatever stands next to it. The ids are found in
  // the raw text and each piece is escaped on its own, so an apostrophe's &#39; is never read as one;
  // a number that names no item stays text. A path:lines@commit reference opens that code (B23). It
  // counts only as a whole word, never as the tail of one, so what it opens is what it says, and the
  // view refuses what is no path in the repo.
  const mark = (x) => (x.shout_decision ? '<span class="mark ask" role="group" title="decision" aria-label="decision">decision</span> ' : x.shout_answers ? '<span class="mark" role="group" title="answer" aria-label="answer">answer</span> ' : '');
  // Evidence a shout carries (B22), as the fields it is: its kind and outcome, the item, who sent it,
  // and the commit, shortened, with the full SHA on hover.
  const evidence = (x) => (x.shout_evidence_kind ? '<div class="receipt"><div><span class="badge">' + esc(x.shout_evidence_kind) + '</span> <span class="outcome">' + esc(x.shout_evidence_outcome) + '</span></div>'
    + '<div class="receipt-foot">' + linked('#' + x.shout_evidence_item, titles) + ' · ' + esc(agentName(x.shout_from)) + ' · ' + codeChip(String(x.shout_evidence_commit), 'sha') + '</div></div>' : '');
  // A shout as a card (#250): who, in a colour of their own, to whom, its item and when on top; what was said
  // below. An ask carries a band until it is answered; a long shout folds at six lines.
  const hue = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 8;
  const initials = (id) => { const [name, rest = ''] = String(id).split(/[-_ ]/); const digits = rest.replace(/\\D/g, ''); return (name.slice(0, digits ? 1 : 2) + digits.slice(0, 3)).toUpperCase(); };
  const questions = [...p.decisions, ...p.asked, ...(p.decisionQueue || [])];
  const open = new Set(questions.map((d) => d.shout_id));
  const answerOf = new Map(p.shouts.filter((y) => y.shout_answers).map((y) => [y.shout_answers, y]));
  const band = (x) => !x.shout_decision ? '' : open.has(x.shout_id) ? '<div class="band">Decision needed</div>'
    : '<div class="band done">Answered' + (answerOf.has(x.shout_id) ? ' by ' + esc(agentName(answerOf.get(x.shout_id).shout_from)) + ': <a href="#shout-' + answerOf.get(x.shout_id).shout_id + '">see the answer</a>' : '') + '</div>';
  // The shout's item: the first #N in its text that names an item on this board, or else its evidence's.
  const itemOf = (x) => /^item:([1-9]\\d*)$/.exec(String(x.shout_to))?.[1] || [...String(x.shout_text).matchAll(/#(\\d+)/g)].map((m) => String(Number(m[1]))).find((id) => titles.has(id)) || x.shout_evidence_item;
  // The coordinator's mark is the board's own: a square with the Pullboard logo, so it stands out from the agents.
  const LEAD = '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect width="56" height="14" x="3" y="25" fill="var(--accent)" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg>';
  const lead = (from) => from === 'coordinator';
  // A shout's recipient in product words: the reserved coordinator+person address and item:<id> are internal.
  const shoutTo = (to) => {
    if (to === 'coordinator+person') return 'coordinator and you';
    const item = /^item:([1-9]\\d*)$/.exec(String(to));
    return item ? '<a class="ref" href="' + esc(itemAddress(item[1], view.root)) + '" data-go="item:' + item[1] + '">#' + item[1] + '</a>' : p.agents.some(agent => agent.agent_id === to) ? '<span data-agent-address="' + esc(to) + '" role="group" aria-label="' + esc(agentName(to)) + '" title="' + esc(modelOf(to)) + '">' + esc(to) + '</span>' : esc(to === 'person' ? 'you' : to);
  };
  // Opened from the status bar's unread, the feed is exactly those shouts, the ones after the mark the person had.
  const unread = view.unread?.root === view.root ? view.unread : null;
  const addressed = addressedShouts.get(JSON.stringify([view.root, view.shout]));
  const shownShouts = addressed?.shout && !p.shouts.some((entry) => entry.shout_id === view.shout) ? [...p.shouts, addressed.shout] : p.shouts;
  const feedShouts = [...shownShouts, ...olderShoutsOf(view.root, shownShouts)];
  const heard = unread ? feedShouts.filter((x) => x.shout_id > unread.after) : view.agent ? feedShouts.filter((x) => x.shout_from === view.agent || x.shout_to === view.agent) : feedShouts;
  const bar = !unread && !view.agent ? '' : '<div class="feed-bar">' + (unread ? '<span><b>' + heard.length + '</b> unread <button class="link" data-unread type="button">show all</button></span>'
    : '<span>Shouts with <b>' + esc(agentName(view.agent)) + '</b> <button class="link" data-agent="" type="button">show all</button></span>') + '</div>';
  $('shouts-pane').classList.toggle('bare', view.agentsHidden);
  // Who has heard a shout of the person's: the agents it reached whose inbox has read past it. Each agent's read
  // cursor is already on the board, so this is presentation only; reading is all it says, not acting on it.
  const reached = (x, a) => a.agent_id !== x.shout_from && ['all', a.agent_id, a.agent_lane].includes(x.shout_to);
  const dot = (a) => '<span class="heard-face h' + hue(a.agent_id) + (lead(a.agent_id) ? ' lead' : '') + '">' + (lead(a.agent_id) ? LEAD : esc(initials(a.agent_id))) + '</span>';
  const heardBy = (x) => {
    if (x.shout_from !== 'person') return '';
    const to = p.agents.filter((a) => reached(x, a)), by = to.filter((a) => (a.agent_last_shout_id ?? 0) >= x.shout_id);
    // A shout that reaches no agent at all, such as one to a lane nobody has joined, has not been heard either.
    if (!by.length) return '<div class="heard not">Not heard yet</div>';
    const first = by.find((a) => lead(a.agent_id)) || by[0], rest = by.length - 1;
    return '<div class="heard" title="Heard by ' + esc(by.map((a) => agentName(a.agent_id)).join(', ')) + '">Heard by ' + esc(agentName(first.agent_id)) + (rest ? ' and ' + rest + (rest === 1 ? ' agent' : ' agents') : '') + '</div>';
  };
  // One card for a shout, in the feed and among the asks; tail adds what the place needs, such as Answer. Only the
  // feed's copy carries the band and the id an answer's link lands on, so an ask shown twice never repeats an id.
  // The person's own shout is signed "you", plainly, never as the coordinator that ran it.
  /** Keep model spelling consistent without rewriting the recorded message or native seat id. */
  const modelLabel = value => {
    const model = String(value || 'unknown').trim();
    if (privateCost) return modelPresentation(model).name;
    if (/^gpt[- ]6[.]1[- ]sol$/i.test(model)) return 'GPT-6.1 Sol';
    if (/^(?:claude[- ]?)?opus[- ]5[.]5$/i.test(model)) return 'Claude Opus 5.5';
    if (/^codex$/i.test(model)) return 'Codex';
    return model;
  };
  const modelOf = id => modelLabel(p.agents.find(agent => agent.agent_id === id)?.model);
  /** Share the original native notice formatting between previews and full messages, preserving authored words. */
  const messageText = message => findingWords({ why: message.shout_text }, message.shout_from !== 'sentinel').text;
  /** A message keeps the exact native words; only references and disclosure add presentation. */
  const card = (x, tail = '') => '<article class="shout' + (lead(x.shout_from) ? ' lead' : '') + (openShouts.has(x.shout_id) ? ' open' : '') + (x.shout_id === view.shout ? ' found' : '') + '" id="shout-' + x.shout_id + '" data-shout-id="' + x.shout_id + '"><div class="shout-main">'
    + (x.shout_id === view.shout ? '<h2 class="visually-hidden">Shout #' + x.shout_id + '</h2>' : '')
    + '<header><b class="who" data-agent-address="' + esc(x.shout_from) + '" role="group" aria-label="' + esc(agentName(x.shout_from)) + '" title="' + esc(modelOf(x.shout_from)) + '">' + esc(x.shout_from === 'person' ? 'you' : x.shout_from) + '</b><span class="to">→ ' + shoutTo(x.shout_to) + '</span>' + mark(x) + '<time title="' + esc(when(x.shout_at)) + '">' + esc(clock(x.shout_at)) + '</time></header>'
    + '<div class="text">' + rich(messageText(x), titles, true, view.root, true) + (x.options ? '<ol>' + x.options.map(option => '<li>' + esc(option) + '</li>').join('') + '</ol>' : '') + '</div><button class="more" data-more type="button" aria-expanded="' + openShouts.has(x.shout_id) + '">' + (openShouts.has(x.shout_id) ? 'Show less' : 'Show all') + '</button>' + band(x) + evidence(x) + heardBy(x) + tail + '</div></article>';
  // Native pending-question lists are authoritative: answered or stale asks never keep a thread amber.
  const uniqueShouts = new Map((unread ? heard : [...heard, ...questions]).map(x => [x.shout_id, x]));
  /** Replies inherit their original question's item even when the answer names no item. */
  const conversationItem = message => {
    const visited = new Set();
    for (let entry = message; entry && !visited.has(entry.shout_id); entry = uniqueShouts.get(entry.shout_answers)) {
      visited.add(entry.shout_id);
      const item = itemOf(entry);
      if (item) return item;
    }
    return null;
  };
  const conversations = new Map();
  for (const message of uniqueShouts.values()) {
    const item = conversationItem(message), key = item ? 'item:' + item : 'none';
    if (!conversations.has(key)) conversations.set(key, { key, item, messages: [], open: false, toYou: false });
    const conversation = conversations.get(key);
    conversation.messages.push(message);
    conversation.open ||= open.has(message.shout_id);
    conversation.toYou ||= ['person', 'coordinator+person'].includes(message.shout_to);
  }
  const threads = [...conversations.values()].map(thread => ({ ...thread,
    messages: thread.messages.sort((a, b) => a.shout_id - b.shout_id) })).sort((a, b) => b.messages.at(-1).shout_id - a.messages.at(-1).shout_id);
  const filter = view.shoutFilter || 'all';
  $('asks-slot').innerHTML = segmentedToggle({ label: 'Shouts filter', attribute: 'data-shout-filter', value: filter,
    options: [{ value: 'all', label: 'All' }, { value: 'questions', label: 'Questions', count: open.size }, { value: 'you', label: 'To you' }] })
    + (view.agentsHidden ? '<button class="asks-toggle" data-agents-toggle type="button">Show agents</button>' : '');
  const selected = view.shout !== null ? threads.find(thread => thread.messages.some(message => message.shout_id === view.shout))
    : threads.find(thread => thread.key === view.shoutThread);
  /** Render one item conversation as a real button with bounded title and preview columns. */
  const conversationRow = thread => {
    const last = thread.messages.at(-1), title = thread.item ? titles.get(String(thread.item)) : 'No item';
    return '<button class="conversation-row" data-shout-thread="' + esc(thread.key) + '" type="button"><span class="conversation-copy"><span class="conversation-title">'
      + (thread.item ? '<code>#' + esc(thread.item) + '</code> ' : '') + esc(title || 'Item #' + thread.item) + '</span><span class="conversation-preview">' + esc(last.shout_from + ': ' + messageText(last)) + '</span></span><span class="conversation-meta"><time class="long" data-ago="' + esc(last.shout_at) + '" title="' + esc(when(last.shout_at)) + '">' + agoLong(last.shout_at) + '</time><span class="chip' + (thread.open ? ' warn' : '') + '">' + (thread.open ? 'Question open' : thread.messages.length + (thread.messages.length === 1 ? ' message' : ' messages')) + '</span></span></button>';
  };
  const rows = threads.filter(thread => filter === 'all' || (filter === 'questions' ? thread.open : thread.toYou));
  const missingAddress = view.shout !== null && !selected ? '<p class="empty" id="shout-address-status" role="status">' + esc(addressed?.error || 'Loading shout #' + view.shout + '…') + '</p>' : '';
  $('feed').innerHTML = missingAddress + bar + (selected ? '<div class="conversation-heading"><button class="link" data-shout-thread="" type="button">All conversations</button><b>' + (selected.item ? '#' + esc(selected.item) + ' ' + esc(titles.get(String(selected.item)) || '') : 'No item') + '</b></div>'
    + dayRules(selected.messages, message => message.shout_at, message => card(message, open.has(message.shout_id) && message.shout_to === 'person' && !readOnly ? '<button class="ghost answer" data-go="decide:' + message.shout_id + '" type="button">Answer</button>' : ''))
    : rows.length ? dayRules(rows, thread => thread.messages.at(-1).shout_at, conversationRow) : '<div class="empty">' + (filter === 'questions' ? 'No open questions.' : filter === 'you' ? 'No shouts to you.' : 'No shouts yet.') + '</div>');
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
      briefStateHtml: stageMarkup(item, p, gatedOf(item), heldNote(item, p, undefined, panelNow) || '', itemStageMarks(item, p)) };
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
  $('agents').innerHTML = agentsPanelHtml({ ...panelSelection, idleOpen: Boolean(view.open.idle) });
  const held = new Map(p.holds.map((h) => [h.hold_lane, h]));
  $('lanes').innerHTML = working.map((l) => '<div class="lane"><span><b>' + esc(l) + '</b> ' + (held.has(l) ? '<span class="chip no" title="held by ' + esc(agentName(held.get(l).hold_by)) + '">held by ' + esc(agentName(held.get(l).hold_by)) + '</span> <span class="muted">' + linked(held.get(l).hold_reason, titles) + '</span>' : '<span class="chip ok">open</span>') + '</span>' + (held.has(l) ? '<button class="ghost" data-release="' + esc(l) + '" type="button">Release</button>' : '') + '</div>').join('');

  }

  const workingActors = new Set(), recentActors = new Set();
  for (const item of items) {
    if (item.status === 'claimed') {
      const holder = holderOf(item); if (holder) { workingActors.add(holder); recentActors.add(holder); }
    } else {
      const reviewer = reviewerOf(item); if (reviewer) workingActors.add(reviewer);
      if (item.status === 'submitted' && reviewer) recentActors.add(reviewer);
      if (item.builtBy && (['back', 'verify'].includes(stateOf(item)) || staleChip(item))) workingActors.add(item.builtBy);
    }
  }
  const footerBusy = p.agents.filter(agent => workingActors.has(agent.agent_id)
    && (view.allAgents || recentActors.has(agent.agent_id) || agent.lastMoveAt && Date.now() - Date.parse(agent.lastMoveAt) < 36e5));
  // The status bar: what the board is doing, along the foot of the window. Each number is the length of the list its
  // click opens (the Active and To verify filters, the gated rows, the agents panel's rows), and a part with none hides.
  // countUnseen fills the unread shouts once the tab is drawn.
  const release = nextMilestone(p), last = p.events[0];
  const part = (to, n, words, title) => n ? '<button type="button" data-status="' + to + '" title="' + esc(title) + '"><b>' + n + '</b> ' + words + '</button>' : '';
  $('status-board').innerHTML = part('items', active.length, 'items', 'Show the active items') + '<button type="button" id="status-unread" data-status="unread" title="Show the shouts you have not read" hidden></button>'
    + part('agents', footerBusy.length, footerBusy.length === 1 ? 'agent' : 'agents', 'Open the agent floor: ' + footerBusy.map((a) => agentName(a.agent_id)).join(', '))
    + part('verify', active.filter((i) => stateOf(i) === 'verify').length, 'to verify', 'Show the items waiting on a verdict')
    + part('gated', active.filter(gatedOf).length, 'gated', 'Show the open items waiting on another item or a held lane')
    + (release ? '<button type="button" data-status="release" title="' + esc('Show this release on the Roadmap: ' + (release.note || release.name)) + '">' + esc(release.name) + ' <b>' + release.done + '/' + release.total + '</b></button>' : '')
    + (last ? '<button type="button" class="end" data-status="' + (last.item_id ? 'item:' + last.item_id : 'activity') + '" title="' + esc(last.event_at) + '">' + esc(agentName(last.event_by)) + ' ' + esc(eventWords(last.event_kind)) + (last.item_id ? ' #' + last.item_id : '') + ' · ' + age(last.event_at) + '</button>' : '');
  if (view.tab === 'spec') $('spec-fit').innerHTML = (p.fit || []).length ? '<h3>Blueprint fit: ' + p.fit.length + ' unverified ' + (p.fit.length === 1 ? 'proposal' : 'proposals') + ' waiting for you</h3>' + p.fit.map(fitRow).join('') : '';
  for (const kind of ['spec', 'doctrine'].filter(kind => kind === view.tab)) {
    const rows = kind === 'spec' ? p.spec : p.practice;
    const filter = view.rows[kind];
    const feedback = view.specFeedback?.kind === kind && view.specFeedback.root === view.root && view.specFeedback.from === 'list' ? view.specFeedback : null;
    const selectedRows = ruleListModel(rows, { kind, filter, selectedId: view.row[kind],
      addressed: view.tab === kind && view.addressDetail !== null, approvalIds: agentApprovals.map(row => row.id), feedback });
    const { labels, counts: n, shown: shownRows, feedbackId, sectionCounts, sectionReviewCounts, sectionKey } = selectedRows;
    if (kind === 'spec') {
      const tab = $('tabs').querySelector?.('[data-tab=spec]');
      if (tab) { tab.title = selectedRows.decisionTitle; tab.innerHTML = 'Spec <b>' + n.decide + '</b>'; }
    }
    const undecidedIds = new Set(selectedRows.undecidedIds);
    const undecided = row => undecidedIds.has(row.id);
    $(kind + '-chips').innerHTML = segmentedToggle({ label: kind === 'spec' ? 'Spec rows' : 'Doctrine rows', attribute: 'data-rows', value: kind + ':' + filter, options: Object.keys(labels).map(key => ({ value: kind + ':' + key, label: labels[key], count: n[key], title: kind === 'spec' && key === 'decide' ? selectedRows.decisionTitle : undefined })) });
    // With no row picked, or the pick filtered out, the detail opens on the first row shown, as Items does.
    view.row[kind] = selectedRows.nextSelectedId;
    let section = null;
    $(kind + '-list').innerHTML = shownRows.length ? shownRows.map((r) => {
      const currentSection = kind === 'spec' ? r.section : sectionKey(r);
      const sectionRows = !snapshot && (!readOnly || requests) && kind === 'spec' && currentSection !== section ? rows.filter((entry) => entry.section === r.section && undecided(entry)) : [];
      const sectionCount = sectionCounts.get(currentSection);
      const standard = kind === 'doctrine' && r.origin === 'standard';
      const reviewNeeded = standard && ['pending', 'draft'].includes(r.status);
      const sectionName = standard ? 'PB · Pullboard rules' : r.section;
      const sectionAction = standard ? '<span class="doctrine-review-count">' + (sectionReviewCounts.get(currentSection) || 0) + ' to review</span>' : sectionRows.length ? '<button class="spec-section-approve" data-section-approve="' + esc(r.section) + '" title="All rows needing your decision in this Spec section, including rows hidden by the current filter" type="button">Approve all ' + sectionRows.length + ' in this section</button>' : '';
      const head = currentSection !== section ? '<div class="spec-section-head doctrine-section-head"><h4>' + esc(sectionName) + ' <span class="section-count">' + sectionCount + '</span></h4>' + sectionAction + '</div>' : '';
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
    if (feedback && !shownRows.length) $(kind + '-list').innerHTML += specFeedback(feedback);
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
      $('spec-detail').innerHTML = '<div class="spec-detail-content"><div class="spec-detail-section">' + esc(row.section) + '</div><h2><span class="row-id">' + esc(row.id) + '</span>' + text + '</h2><div class="meta"><span class="chip ' + tone(row.status) + '">' + esc(rowStatus.charAt(0).toUpperCase() + rowStatus.slice(1)) + '</span>' + (row.tier ? '<span class="chip tier-pill tier-' + esc(row.tier) + '">' + esc(row.tier) + '</span>' : '') + '</div>'
        + '<div class="spec-fact"><span>Proved by</span><div>' + (row.gate ? specGateFiles(row, true) : 'No gate yet') + '</div></div><div class="spec-fact"><span>Cited by</span><div class="links">' + (citing.length ? citing.map(item => '<div class="links-item spec-citing" role="button" tabindex="0" data-item="' + item.id + '"><span>#' + item.id + ' ' + rich(item.title, titles) + '</span></div>').join('') : 'No items yet') + '</div></div>'
        + (row.serves?.length ? '<div class="spec-fact"><span>Serves</span><div>' + esc(row.serves.join(', ')) + '</div></div>' : '')
        + (reason ? '<dl class="kv">' + reason + '</dl>' : '') + (view.specFeedback?.root === view.root && view.specFeedback.kind === kind && view.specFeedback.id === row.id ? specFeedback(view.specFeedback) : '')
        + '<div class="spec-detail-actions">' + actions + '</div><p class="spec-authority">Only you can decide a row.</p></div>';
      const restored = draft && document.getElementById(draft.id);
      if (restored && draft.value && !restored.value) { restored.value = draft.value; if (draft.focus) restored.focus(); }
      continue;
    }
    if (kind === 'doctrine' && row) {
      const hasFile = (row.gateFiles || []).some(gate => gate.exists === true);
      const facts = '<div class="spec-fact"><span>' + (hasFile ? 'Proved by' : 'Checked by') + '</span><div>' + doctrineCheck(row, true) + '</div></div>'
        + '<div class="spec-fact"><span>Cited by</span><div class="links">' + (citing.length ? citing.map(item => '<div class="links-item spec-citing" data-item="' + item.id + '"><span>#' + item.id + ' ' + rich(item.title, titles) + '</span></div>').join('') : 'No items yet') + '</div></div>';
      $('doctrine-detail').innerHTML = '<div class="spec-detail-content doctrine-detail-content"><div class="spec-detail-section">' + esc(row.section) + '</div><h2><span class="row-id">' + esc(row.id) + '</span>' + text + '</h2><div class="meta"><span class="chip ' + (reviewNeeded ? 'warn' : tone(row.status)) + '">' + esc(rowStatus.charAt(0).toUpperCase() + rowStatus.slice(1)) + '</span>' + (row.tier ? '<span class="chip tier-pill tier-' + esc(row.tier) + '">' + esc(row.tier) + '</span>' : '') + source + '</div>'
        + facts + (reason ? '<dl class="kv">' + reason + '</dl>' : '') + (row.serves?.length ? '<div class="spec-fact"><span>Serves</span><div>' + esc(row.serves.join(', ')) + '</div></div>' : '')
        + (home ? '<p class="doctrine-standard-note">' + esc(home) + '</p>' : '') + (rowDecisionActions ? '<div class="spec-detail-actions">' + rowDecisionActions + '</div>' : '') + '<p class="spec-authority">Only you can decide a row.</p></div>';
      continue;
    }
    $(kind + '-detail').innerHTML = row ? '<div class="stack tight"><h2><span>' + esc(row.id) + '</span>' + text + '</h2><div class="meta"><span class="chip ' + tone(row.status) + '">' + esc(rowStatus) + '</span>' + (row.tier ? '<span class="chip">' + esc(row.tier) + '</span>' : '') + source + '</div>' + rowDecisionActions + (kind === 'spec' && view.specFeedback?.kind === kind && view.specFeedback.root === view.root && view.specFeedback.from === 'detail' && view.specFeedback.id === row.id ? specFeedback(view.specFeedback) : '') + '<dl class="kv"><dt>section</dt><dd>' + esc(row.section) + '</dd>' + reason + (row.gate ? '<dt>gate</dt><dd>' + esc(row.gate) + '</dd>' : '') + (row.serves && row.serves.length ? '<dt>serves</dt><dd>' + esc(row.serves.join(', ')) + '</dd>' : '') + '</dl><div><h3>Items that cite it</h3>' + (citing.length ? '<div class="links">' + citing.map((i) => '<div class="links-item" data-item="' + i.id + '"><span>#' + i.id + ' ' + rich(i.title, titles) + '</span></div>').join('') + '</div>' : '<div class="muted">None yet.</div>') + '</div>' + (home ? '<div class="muted">' + home + '</div>' : '') + '</div>' : '<div class="empty">' + (view.tab === kind && view.addressDetail !== null ? 'No ' + (kind === 'spec' ? 'Spec' : 'Doctrine') + ' row ' + esc(view.addressDetail) + ' exists here.' : 'Pick a row to see it, and the items that cite it.') + '</div>';
  }

  if (view.tab === 'activity') {
  if (keep('pb.flow') === 'shown') $('flow').innerHTML = lifecycleChart(p, p.moveCounts ? new Map(Object.entries(p.moveCounts)) : moveCounts(p.items), p.items.filter(item => stateOf(item) === 'back').length);
  $('activity-filters').innerHTML = activityFilters(activityModel(p, { words: activityWords }), view.activityFilter || 'all');
  const activity = $('activity');
  const activityOpen = activity.dataset.boardRoot === p.root ? [...activity.querySelectorAll('[data-activity-run][open]')].map(entry => entry.dataset.activityRun) : [];
  activity.dataset.boardRoot = p.root;
  const activityTime = value => new Date(value).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const activityLabels = new Map();
  const collectActivityTimes = text => {
    for (const match of String(text ?? '').matchAll(/\\b\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?(?:Z|[+-]\\d\\d:\\d\\d)\\b/gu))
      if (!activityLabels.has(match[0])) activityLabels.set(match[0], Number.isFinite(Date.parse(match[0])) ? activityTime(match[0]) : match[0]);
  };
  const localActivityTimes = text => String(text ?? '').replace(/\\b\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?(?:Z|[+-]\\d\\d:\\d\\d)\\b/gu,
    value => Number.isFinite(Date.parse(value)) ? activityLabels.get(value) ?? value : value);
  const activityModelData = activityModel(p, { words: activityWords });
  const activityRows = activityModelData.rows.map(entry => {
    collectActivityTimes(entry.words);
    for (const finding of [...(entry.findings || []), ...(entry.stillStuck || [])]) {
      for (const value of Object.values(finding)) if (typeof value === 'string') collectActivityTimes(value);
      if (Number.isFinite(Date.parse(finding.since))) activityLabels.set(finding.since, activityTime(finding.since));
    }
    return entry;
  }).map(entry => {
    const prepareFinding = finding => ({ ...finding, words: activityWords(finding, { now: Date.parse(entry.at), timestampLabels: activityLabels }) });
    return { ...entry, timeLabel: activityTime(entry.at), dayKey: new Date(entry.at).toDateString(), dayLabel: dayName(entry.at),
      itemHref: entry.item ? itemAddress(entry.item.id) : null,
      quoteHtml: entry.kind === 'shout' && entry.words ? inline(localActivityTimes(entry.words), titles) : '',
      findings: entry.findings?.map(prepareFinding), stillStuck: entry.stillStuck?.map(prepareFinding),
    };
  });
  activity.innerHTML = activityHtml({ ...activityModelData, rows: activityRows }, { controls: false, filter: view.activityFilter || 'all', open: activityOpen });
  }
  showTab();
  revealPlace();
  revealSegmentedChoices(document);
  updateRoadmapPanel();
  drawHistoryNotes();
}
`;
}
