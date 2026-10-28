/** Render only the selected board pane while preserving shared navigation and status [N26]. */
import { needsActionsHtml } from './needs-actions.js';
import { needsPanelHtml } from './needs-panel.js';
import { agentsPanelModel } from './agents-panel-model.js';
import { agentsPanelHtml } from './agents-panel-render.js';
import { needsPanelModel } from './needs-panel.js';
import { ruleListModel } from './rule-list-model.js';
import { selectItemsView } from './items-selection.js';

/** Return the shared browser-scope renderer without eagerly building hidden pane DOM. */
export function pageRenderScript() {
  return `let drawnRoadmap = null;
const agentsPanelModel = (${agentsPanelModel.toString()});
const agentsPanelHtml = (${agentsPanelHtml.toString()});
const ruleListModel = (${ruleListModel.toString()});
const selectItemsView = (${selectItemsView.toString()});
const needsPanelModel = (${needsPanelModel.toString()});
const needsActionsHtml = (${needsActionsHtml.toString()});

function render() {
  renderIndexes = new WeakMap();
  // A refresh that moved the page to another board closes a confirmation opened on the last one.
  closeIfLeft();
  if (heldClickPointer !== null || pageDialogs.size) { deferredClickRender = true; return; }
  deferredClickRender = false;
  const statsFocus = document.activeElement?.id === 'proof-stats-summary' ? document.activeElement.id : null;
  const p = data.project;
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
  if (view.tab === 'settings') { $('group-view').hidden = true; showTab(); return; }
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
  const gatedOf = (item) => stateOf(item) === 'open' && (item.blockedBy.length > 0 || heldLanes.has(item.lane));
  if (view.tab === 'roadmap') {
  // Every refresh redraws the Roadmap. Left alone, that would send the phone's release chips back to their start
  // and the panel back to its top under a person mid-scroll, so both keep where they were.
  const chipsAt = $('roadmap-releases')?.scrollLeft ?? 0, panelAt = $('roadmap-panel')?.scrollTop ?? 0;
  roadmapAhead.clear();
  roadmapDetails.clear();
  const roadmapHtml = roadmapCards(p, titles);
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
  const needsTab = ['home', 'items', 'dashboard'].includes(view.tab);
  const personalNeeds = needsTab || ['spec', 'doctrine'].includes(view.tab) ? personNeeds(p) : [];
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
  if (view.tab === 'dashboard') dashboardView.draw(p,needsPanel({...needsModel,compact:true},needsPresentation));
  else {
    const needsHtml = needsPanel(needsModel,needsPresentation);
    if (view.tab === 'items') {
      $('needs').hidden = !personalNeeds.length || view.state !== 'active' || Boolean(view.lane);
      $('needs').tabIndex = -1;
      $('needs').innerHTML = needsHtml;
    } else {
      $('home-rules').innerHTML = homeRules(p.spec);
      $('home-capacity').innerHTML = homeCapacity(p.capacityForecast);
      $('home-needs').innerHTML = needsHtml;
      $('home-calm').hidden = Boolean(needsHtml);
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

  // An open item's chip, the same in its row and its detail: gated, its lane held, or unclaimed.
  const openChip = (i) => (p.itemHolds || []).some((h) => h.item === i.id) ? heldChip(heldNote(i, p, undefined, Date.now())) : i.blockedBy.length || heldLanes.has(i.lane) ? '<span class="chip gate">' + (i.blockedBy.length ? 'gated' : 'lane held') + '</span>' : chip('open');
  $('chain').innerHTML = shown.length ? shown.map((i) => {
    const s = stateOf(i);
    // What an open item waits on, if anything: items not yet verified, or a hold on its lane.
    const hold = s === 'open' ? heldLanes.get(i.lane) : null;
    const waits = s === 'open' && i.blockedBy.length ? i.blockedBy : [];
    const gated = gatedOf(i);
    const pills = (waits.length ? '<span class="gate">' + waits.map((id, index) => '<span class="wait-unit">' + (index ? '' : 'waits on ') + '<a class="ref" href="' + esc(itemAddress(id)) + '" data-go="item:' + id + '">#' + id + '</a></span>').join(', ') + '</span>' : '') + (hold ? '<span class="gate">lane held: ' + linked(hold.hold_reason, titles) + '</span>' : '');
    const holder = holderOf(i), reviewer = reviewerOf(i);
    const tag = s === 'building' && holder ? '<span class="chip busy" title="building, held by ' + esc(agentName(holder)) + '">' + esc(agentName(holder)) + '</span>'
      : s === 'verify' && reviewer ? '<span class="chip warn" title="reviewing until ' + esc(when(i.claim?.until ?? i.reviewUntil)) + '">' + esc(agentName(reviewer)) + ' reviewing</span>'
      : s === 'open' ? openChip(i) : chip(s);
    return sharedRowHtml({ className: (view.item === i.id ? 'on ' : '') + (gated ? 'gated ' : ''), attributes: { 'data-item': i.id }, title: i.title, state: s,
      primaryHtml: '<span>#' + i.id + '</span>' + rich(i.title, titles), timeHtml: age(i.updatedAt), chipHtml: tag,
      // A rejected row's second line is its verdict; any other row's is its lane and the spec ids it serves.
      metaHtml: (rejected(i) ? '<span class="why"><b>' + esc(i.verdict.reason) + '</b> ' + linked(firstLine(visibleVerdictNote(i.verdict.reason, i.verdict.note)), titles) + '</span>'
        : '<span>' + esc(i.lane) + '</span>' + (i.specs.length ? '<span class="specs" title="' + esc(i.specs.join(', ')) + '">' + esc(i.specs.slice(0, 3).join(', ') + (i.specs.length > 3 ? ' +' + (i.specs.length - 3) : '')) + '</span>' : '')) + pills + staleChip(i) });
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
  const head = (item, s = stateOf(item)) => '<div><h2><span>#' + item.id + '</span>' + rich(item.title, titles) + '</h2><div class="meta spaced">' + (s === 'open' ? openChip(item) : chip(s)) + staleChip(item) + '<span class="chip">' + esc(item.lane) + '</span><span class="chip">' + esc(item.route) + '</span></div></div>';
  if (opened?.error) $('detail').innerHTML = '<div class="stack"><p class="detail-wait muted" role="status">Could not load #' + selected.id + ': ' + esc(opened.error) + '</p></div>';
  // Until its omitted fields arrive, an opened item paints its heading from its summary and fills the rest in place (#1039).
  else if (opened?.loading) $('detail').innerHTML = '<div class="stack" aria-busy="true">' + head(selected) + '</div>';
  const item = opened?.item;
  if (item) {
    const s = stateOf(item);
    const cited = item.specs.map((id) => p.spec.find((r) => r.id === id) || { id, status: 'missing', text: '(not in SPEC.md)' });
    const baseline = item.checkBaseline;
    const baselineClass = baseline?.result === 'green' ? 'ok' : baseline?.result === 'red' ? 'no' : baseline?.result === 'pending' ? 'warn' : '';
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
        return '<div class="fact-code"><span class="chip">' + esc(fact.kind) + '</span> <span class="muted">' + esc(agentName(fact.by)) + ' · ' + age(fact.at) + '</span><div class="code no ref-missing" role="status">Code reference unavailable: missing or invalid ' + esc(missing) + '.</div></div>';
      }
      const range = path + ':' + start + (end === start ? '' : '-' + end) + '@' + commit;
      return '<div class="fact-code"><span class="chip">' + esc(fact.kind) + '</span> <span class="muted">' + esc(agentName(fact.by)) + ' · ' + age(fact.at) + '</span>' + codeRef(range, '', true) + '</div>';
    }).join('') + '</div>' : '';
    // Why it came back is the first thing the person reads; the verdicts before it stay below.
    const back = rejected(item);
    const earlier = back ? item.verdicts.slice(0, -1) : item.verdicts;
    $('detail').innerHTML = '<div class="stack">' + head(item, s)
      + (back ? '<div class="sentback"><h3>Sent back' + (s === 'building' ? ', being reworked' : s === 'verify' ? ', resubmitted' : s === 'withdrawn' ? ', then withdrawn' : '') + '</h3>' + verdictHtml(item.verdict, titles) + '</div>' : '')
      + (item.criterion ? '<div><h3>Criterion</h3><div class="text">' + rich(item.criterion, titles) + '</div></div>' : '')
      + (item.check ? '<div><h3>Check</h3><dl class="kv"><dt>command</dt><dd><code>' + esc(item.check) + '</code></dd><dt>baseline</dt><dd><span class="chip ' + baselineClass + '">' + esc(baseline?.result ?? 'not recorded') + '</span></dd></dl>'
        + (baseline?.warning === 'CRITERION_PROVES_NOTHING' ? '<p class="check-warning">This check already passed before the work, so it proves nothing.</p>' : '') + '</div>' : '')
      + referencedCode
      + (cited.length ? '<div><h3>Spec rows it serves</h3>' + cited.map((r) => '<div class="rowref"><code>' + esc(r.id) + '</code><div>' + linked(r.text, titles) + ' <span class="chip ' + tone(r.status) + '">' + esc(r.status) + '</span></div></div>').join('') + '</div>' : '')
      + (item.brief ? '<div><h3>Brief</h3><div class="text muted">' + rich(item.brief, titles) + '</div></div>' : '')
      + '<div><h3>People and commits</h3><dl class="kv">' + (item.owner && s === 'building' ? '<dt>holding</dt><dd>' + esc(agentName(item.owner)) + '</dd>' : '') + (item.builtBy ? '<dt>built by</dt><dd>' + esc(agentName(item.builtBy)) + '</dd>' : '') + (item.verifiedBy ? '<dt>verified by</dt><dd>' + esc(agentName(item.verifiedBy)) + '</dd>' : '') + (item.commit ? '<dt>commit</dt><dd><code>' + esc(item.commit.slice(0, 12)) + '</code></dd>' : '') + (item.merged ? '<dt>merged</dt><dd><code>' + esc(item.merged.slice(0, 12)) + '</code></dd>' : '') + (item.blockedBy.length ? '<dt>waits on</dt><dd class="waits-on">' + item.blockedBy.map((id) => '<span class="wait-unit"><a class="ref" href="' + esc(itemAddress(id)) + '" data-go="item:' + id + '">#' + id + '</a></span>').join(', ') + '</dd>' : '') + '</dl></div>'
      + (back && !earlier.length ? '' : '<div><h3>' + (back ? 'Earlier verdicts' : 'Verdicts') + '</h3>' + (earlier.length ? earlier.map((v) => verdictHtml(v, titles)).join('') : '<div class="muted">None yet.</div>') + '</div>')
      + '<div><h3>History</h3>' + timeline(item) + '</div>'
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
  const open = new Set([...p.decisions, ...p.asked].map((d) => d.shout_id));
  const answerOf = new Map(p.shouts.filter((y) => y.shout_answers).map((y) => [y.shout_answers, y]));
  const band = (x) => !x.shout_decision ? '' : open.has(x.shout_id) ? '<div class="band">Decision needed</div>'
    : '<div class="band done">Answered' + (answerOf.has(x.shout_id) ? ' by ' + esc(agentName(answerOf.get(x.shout_id).shout_from)) + ': <a href="#shout-' + answerOf.get(x.shout_id).shout_id + '">see the answer</a>' : '') + '</div>';
  // The shout's item: the first #N in its text that names an item on this board, or else its evidence's.
  const itemOf = (x) => [...String(x.shout_text).matchAll(/#(\\d+)/g)].map((m) => String(Number(m[1]))).find((id) => titles.has(id)) || x.shout_evidence_item;
  // The coordinator's mark is the board's own: a square with the Pullboard logo, so it stands out from the agents.
  const LEAD = '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect width="56" height="14" x="3" y="25" fill="var(--accent)" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg>';
  const lead = (from) => from === 'coordinator';
  // A shout's recipient in product words: the reserved coordinator+person address and item:<id> are internal.
  const shoutTo = (to) => {
    if (to === 'coordinator+person') return 'coordinator and you';
    const item = /^item:([1-9]\\d*)$/.exec(String(to));
    return item ? '<a class="ref" href="' + esc(itemAddress(item[1], view.root)) + '" data-go="item:' + item[1] + '">#' + item[1] + '</a>' : shoutAgentName(to);
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
    return '<div class="heard" title="Heard by ' + esc(by.map((a) => agentName(a.agent_id)).join(', ')) + '"><span class="heard-faces">' + [first, ...by.filter((a) => a !== first)].slice(0, 4).map(dot).join('') + '</span>Heard by ' + esc(agentName(first.agent_id)) + (rest ? ' and ' + rest + (rest === 1 ? ' agent' : ' agents') : '') + '</div>';
  };
  // One card for a shout, in the feed and among the asks; tail adds what the place needs, such as Answer. Only the
  // feed's copy carries the band and the id an answer's link lands on, so an ask shown twice never repeats an id.
  // The person's own shout is signed "you", plainly, never as the coordinator that ran it.
  const card = (x, tail = '', inFeed = true) => '<article class="shout h' + hue(x.shout_from) + (lead(x.shout_from) ? ' lead' : '') + (openShouts.has(x.shout_id) ? ' open' : '') + (inFeed && x.shout_id === view.shout ? ' found' : '') + '"' + (inFeed ? ' id="shout-' + x.shout_id + '"' : '') + ' data-shout-id="' + x.shout_id + '">'
    + (lead(x.shout_from) ? '<span class="avatar">' + LEAD + '</span>' : '<span class="avatar' + (initials(x.shout_from).length > 3 ? ' wide' : '') + '" aria-hidden="true">' + esc(initials(x.shout_from)) + '</span>') + '<div class="shout-main">' + (inFeed && x.shout_id === view.shout ? '<h2 class="visually-hidden">Shout #' + x.shout_id + '</h2>' : '') + '<header><b class="who">' + (x.shout_from === 'person' ? 'you' : shoutAgentName(x.shout_from)) + '</b><span class="to">→ ' + shoutTo(x.shout_to) + '</span>'
    + (itemOf(x) ? '<span class="item">#' + esc(itemOf(x)) + '</span>' : '') + mark(x) + '<time class="long" data-ago="' + esc(x.shout_at) + '" title="' + esc(when(x.shout_at)) + '">' + agoLong(x.shout_at) + '</time></header>'
    + '<div class="text">' + rich(x.shout_text, titles) + (x.options ? '<ol>' + x.options.map((option) => '<li>' + esc(option) + '</li>').join('') + '</ol>' : '') + '</div><button class="more" data-more type="button">' + (openShouts.has(x.shout_id) ? 'less' : 'more') + '</button>' + (inFeed ? band(x) + heardBy(x) : '') + evidence(x) + tail + '</div></article>';
  $('feed').innerHTML = (view.shout !== null && !feedShouts.some((entry) => entry.shout_id === view.shout) ? '<p class="empty" id="shout-address-status" role="status">' + esc(addressed?.error || 'Loading shout #' + view.shout + '…') + '</p>' : '') + bar + (heard.length ? dayRules(heard, (x) => x.shout_at, card) : '<div class="empty">' + (unread ? 'No unread shouts.' : view.agent ? 'No shouts with ' + esc(agentName(view.agent)) + ' among the last forty.' : 'No shouts yet.') + '</div>');
  foldShouts();
  // Each ask waits here until answered (B21), typed in the form below; the person answers those passed up, the rest wait on their holder (B26).
  const coordinatorQueue = p.decisionQueue || []; $('coordinator-decisions').hidden = !coordinatorQueue.length; $('coordinator-decisions').innerHTML = coordinatorQueue.length ? '<div class="head"><i></i>Coordinator decisions</div>' + coordinatorQueue.map((d) => card(d, !readOnly && !requests && !snapshot ? '<button class="ghost answer" data-go="coordinate:' + d.shout_id + '" type="button">Answer as coordinator</button>' : '', false)).join('') : '';
  $('decisions').hidden = !p.decisions.length && !(p.asked.length && view.open.waiting);
  // The asks waiting on others are a toggle at the end of the composer's line, beside Show agents while the panel is hidden.
  $('asks-slot').innerHTML = (p.asked.length ? '<button class="asks-toggle" data-fold="waiting" type="button" aria-expanded="' + Boolean(view.open.waiting) + '" title="' + esc('Asks between agents, waiting on others: ' + p.asked.map((d) => agentName(d.shout_from) + ' asks ' + agentName(d.shout_to)).join(', ')) + '">' + p.asked.length + (p.asked.length === 1 ? ' ask' : ' asks') + ' waiting <span aria-hidden="true">' + (view.open.waiting ? '▴' : '▾') + '</span></button>' : '')
    + (view.agentsHidden ? '<button class="asks-toggle" data-agents-toggle type="button">Show agents</button>' : '');
  // The asks as the feed's cards, folded to three lines: the person's to answer, then those waiting on others.
  $('decisions').innerHTML = (p.decisions.length ? '<div class="head"><i></i>Decision needed</div>' + p.decisions.map((d) => card(d, '<button class="ghost answer" data-go="decide:' + d.shout_id + '" type="button">Answer</button>', false)).join('') : '')
    // Asks waiting on someone else are not the person's to answer: they show only once the composer's toggle opens them.
    + (p.asked.length && view.open.waiting ? p.asked.map((d) => card(d, '', false)).join('') : '');
  foldShouts();
  // Prepare agent, item-state and display observations before the pure selection and HTML functions.
  const panelNow = Date.now();
  const agentItems = items.map((item) => {
    const stale = staleChip(item);
    const state = stateOf(item);
    return { id: item.id, status: item.status, holder: holderOf(item), reviewer: reviewerOf(item), builtBy: item.builtBy,
      state, stale: Boolean(stale), titleTextHtml: esc(item.title), titleHtml: rich(item.title, titles),
      stateHtml: chip(state) + stale, briefStateHtml: stale || chip(state) };
  });
  const agentRows = p.agents.map((agent) => {
    const isLead = lead(agent.agent_id);
    const letters = initials(agent.agent_id);
    return { agentId: agent.agent_id, name: agentName(agent.agent_id), nameHtml: esc(agentName(agent.agent_id)),
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
    + part('agents', footerBusy.length, footerBusy.length === 1 ? 'agent' : 'agents', 'Show the agents holding work: ' + footerBusy.map((a) => agentName(a.agent_id)).join(', '))
    + part('verify', active.filter((i) => stateOf(i) === 'verify').length, 'to verify', 'Show the items waiting on a verdict')
    + part('gated', active.filter(gatedOf).length, 'gated', 'Show the open items waiting on another item or a held lane')
    + (release ? '<button type="button" data-status="release" title="' + esc('Show this release on the Roadmap: ' + (release.note || release.name)) + '">' + esc(release.name) + ' <b>' + release.done + '/' + release.total + '</b></button>' : '')
    + (last ? '<button type="button" class="end" data-status="' + (last.item_id ? 'item:' + last.item_id : 'activity') + '" title="' + esc(last.event_at) + '">' + esc(agentName(last.event_by)) + ' ' + esc(last.event_kind) + (last.item_id ? ' #' + last.item_id : '') + ' · ' + age(last.event_at) + '</button>' : '');
  if (view.tab === 'spec') $('spec-fit').innerHTML = (p.fit || []).length ? '<h3>Blueprint fit: ' + p.fit.length + ' unverified ' + (p.fit.length === 1 ? 'proposal' : 'proposals') + ' waiting for you</h3>' + p.fit.map(fitRow).join('') : '';
  for (const kind of ['spec', 'doctrine'].filter(kind => kind === view.tab)) {
    const rows = kind === 'spec' ? p.spec : p.practice;
    const filter = view.rows[kind];
    const feedback = view.specFeedback?.kind === kind && view.specFeedback.root === view.root && view.specFeedback.from === 'list' ? view.specFeedback : null;
    const selectedRows = ruleListModel(rows, { kind, filter, selectedId: view.row[kind],
      addressed: view.tab === kind && view.addressDetail !== null, approvalIds: agentApprovals.map(row => row.id), feedback });
    const { labels, counts: n, shown: shownRows, feedbackId, sectionCounts } = selectedRows;
    const undecidedIds = new Set(selectedRows.undecidedIds);
    const undecided = row => undecidedIds.has(row.id);
    $(kind + '-chips').innerHTML = segmentedToggle({ label: kind === 'spec' ? 'Spec rows' : 'Doctrine rows', attribute: 'data-rows', value: kind + ':' + filter, options: Object.keys(labels).map(key => ({ value: kind + ':' + key, label: labels[key], count: n[key] })) });
    // With no row picked, or the pick filtered out, the detail opens on the first row shown, as Items does.
    view.row[kind] = selectedRows.nextSelectedId;
    let section = null;
    $(kind + '-list').innerHTML = shownRows.length ? shownRows.map((r) => {
      const sectionRows = !snapshot && (!readOnly || requests) && kind === 'spec' && r.section !== section ? rows.filter((entry) => entry.section === r.section && undecided(entry)) : [];
      const sectionCount = sectionCounts.get(r.section);
      const head = r.section !== section ? '<div class="spec-section-head"><h4>' + esc(r.section) + ' <span class="section-count">' + sectionCount + '</span></h4>' + (sectionRows.length ? '<button class="spec-section-approve" data-section-approve="' + esc(r.section) + '" type="button">Approve all ' + sectionRows.length + ' in this section</button>' : '') + '</div>' : '';
      section = r.section;
      const declined = kind === 'doctrine' && r.status === 'wont';
      const text = declined ? '<s>' + linked(r.standardText || r.text, titles) + '</s>' : linked(r.text, titles);
      const source = kind === 'doctrine' ? ruleSource(r) : 'this repo';
      const reason = (declined || kind === 'spec' && r.status === 'wont') && r.reason ? '<span class="rule-reason" title="' + esc(r.reason) + '">Reason: ' + linked(r.reason, titles) + '</span>' : '';
      const secondary = '<span class="rule-source" title="' + esc(source) + '">' + esc(source) + '</span>' + reason + (r.gate ? '<span class="gate" title="' + esc(r.gate) + '">' + esc(r.gate) + '</span>' : '');
      const statusShown = filter === 'all' || !!r.staleDecision || (filter === 'decide' && r.status !== 'draft');
      const badge = statusShown ? '<span class="chip ' + tone(r.status) + '">' + esc(r.stage || r.status) + '</span>' : r.tier ? '<span class="chip">' + esc(r.tier) + '</span>' : '';
      const citations = renderIndex(p).citations.get(r.id)?.length || 0;
      return head + (feedback && feedbackId === r.id ? specFeedback(feedback) : '') + recordRow({ tag: 'div', classes: view.row[kind] === r.id ? 'on' : '', attributes: 'data-row="' + kind + ':' + esc(r.id) + '"', title: r.text,
        state: r.status === 'approved' ? 'verified' : r.status === 'wont' ? 'back' : 'open', primary: '<span class="row-id">' + esc(r.id) + '</span>' + text,
        secondary, rightTop: citations ? count(citations, 'item', 'items') : '', rightBottom: badge });
    }).join('') : '<div class="empty">' + (rows.length ? 'No rows match.' : kind === 'spec' ? 'No spec rows yet. Each requirement is one row in SPEC.md, such as G1 [draft, must] and a line; write them, or ask an agent to, and they show up here.' : 'No doctrine rows yet: they live in DOCTRINE.md.') + '</div>';
    if (feedback && !shownRows.length) $(kind + '-list').innerHTML += specFeedback(feedback);
    const row = rows.find((r) => r.id === view.row[kind]);
    const citing = row ? renderIndex(p).citations.get(row.id) || [] : [];
    const declined = kind === 'doctrine' && row && row.status === 'wont';
    const text = row ? declined ? '<s>' + linked(row.standardText || row.text, titles) + '</s>' : linked(row.text, titles) : '';
    const source = kind === 'doctrine' && row ? '<span class="chip" title="' + esc(ruleSourceTitle(row)) + '">' + esc(ruleSource(row)) + '</span>' : '';
    const reason = (declined || kind === 'spec' && row?.status === 'wont') && row?.reason ? '<dt>reason</dt><dd>' + linked(row.reason, titles) + '</dd>' : '';
    // Only a standard rule gets a note; who approves rows is said once elsewhere, not in every detail (#822).
    const home = kind === 'doctrine' && row && row.origin === 'standard' ? 'Standard rules come with Pullboard as defaults to review; override or decline one in DOCTRINE.md.' : '';
    const rowStatus = row?.stage || row?.status;
    const agentApproval = kind === 'spec' && row ? agentApprovals.find(approval => approval.id === row.id) : null;
    const rowDecisionActions = agentApproval ? agentApprovalActions(agentApproval, true) : !snapshot && (!readOnly || requests) && row && undecided(row) && (kind === 'spec' || row.origin !== 'standard')
      ? '<div class="spec-decision-actions detail-decision-actions"><button class="approve-row" data-row-decision="approve" data-row-kind="' + kind + '" data-row-id="' + esc(row.id) + '" title="Approve (A, from the list)" type="button">Approve <kbd>A</kbd></button><button class="decline-row" data-row-decision="decline" data-row-kind="' + kind + '" data-row-id="' + esc(row.id) + '" title="Decline (D, from the list)" type="button">Decline <kbd>D</kbd></button></div>'
      : '';
    $(kind + '-detail').innerHTML = row ? '<div class="stack tight"><h2><span>' + esc(row.id) + '</span>' + text + '</h2><div class="meta"><span class="chip ' + tone(row.status) + '">' + esc(rowStatus) + '</span>' + (row.tier ? '<span class="chip">' + esc(row.tier) + '</span>' : '') + source + '</div>' + rowDecisionActions + (kind === 'spec' && view.specFeedback?.kind === kind && view.specFeedback.root === view.root && view.specFeedback.from === 'detail' && view.specFeedback.id === row.id ? specFeedback(view.specFeedback) : '') + '<dl class="kv"><dt>section</dt><dd>' + esc(row.section) + '</dd>' + reason + (row.gate ? '<dt>gate</dt><dd>' + esc(row.gate) + '</dd>' : '') + (row.serves && row.serves.length ? '<dt>serves</dt><dd>' + esc(row.serves.join(', ')) + '</dd>' : '') + '</dl><div><h3>Items that cite it</h3>' + (citing.length ? '<div class="links">' + citing.map((i) => '<div class="links-item" data-item="' + i.id + '"><span>#' + i.id + ' ' + rich(i.title, titles) + '</span></div>').join('') + '</div>' : '<div class="muted">None yet.</div>') + '</div>' + (home ? '<div class="muted">' + home + '</div>' : '') + '</div>' : '<div class="empty">' + (view.tab === kind && view.addressDetail !== null ? 'No ' + (kind === 'spec' ? 'Spec' : 'Doctrine') + ' row ' + esc(view.addressDetail) + ' exists here.' : 'Pick a row to see it, and the items that cite it.') + '</div>';
  }

  if (view.tab === 'activity') {
  if (keep('pb.flow') === 'shown') $('flow').innerHTML = lifecycleChart(p, p.moveCounts ? new Map(Object.entries(p.moveCounts)) : moveCounts(p.items), p.items.filter(item => stateOf(item) === 'back').length);
  $('activity-filters').innerHTML = activityFilters(activityModel(p), view.activityFilter || 'all');
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
  const activityModelData = activityModel(p);
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
