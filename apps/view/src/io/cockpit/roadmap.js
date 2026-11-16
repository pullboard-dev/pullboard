/** Return the original roadmap section of the self-contained cockpit document. */
export function cockpitRoadmap(sections) {
  const { milestoneRowHtml, readMilestoneModel, roadmapRemainingCount, roadmapCardsHtml } = sections;
  return `/** Index only the immutable board objects used during this synchronous render. */
function renderIndex(project) {
  if (!project) return { items: new Map(), titles: new Map(), releases: new Map(), citations: new Map() };
  if (!renderIndexes.has(project)) {
    const releases = new Map();
    for (const milestone of project.milestones || []) {
      for (const id of new Set(milestone.items.map(entry => entry.id))) {
        if (!releases.has(id)) releases.set(id, []);
        releases.get(id).push(milestone.name);
      }
    }
    const citations = new Map();
    for (const item of project.items || []) for (const id of new Set(item.specs || [])) {
      if (!citations.has(id)) citations.set(id, []);
      citations.get(id).push(item);
    }
    renderIndexes.set(project, { citations, items: new Map((project.items || []).map(item => [item.id, item])),
      titles: new Map((project.items || []).map(item => [String(item.id), item.title])), releases });
  }
  return renderIndexes.get(project);
}

/** Resolve a milestone item from the current render's exact local or foreign board snapshot. */
function milestoneItem(entry, p, counting = false) {
  const local = typeof entry.id === 'number';
  const ref = local ? null : /^(.+)#([1-9]\\d*)$/.exec(String(entry.id));
  const named = ref ? data.projects.filter((x) => x.name === ref[1] || String(x.root).split('/').pop() === ref[1]) : [];
  const root = local ? view.root : named.length === 1 && named[0].ok ? named[0].root : null;
  const id = local ? entry.id : ref ? Number(ref[2]) : null;
  const source = root === view.root ? p : root ? named[0] : null;
  const item = renderIndex(source).items.get(id) || null;
  const label = local ? '#' + entry.id : String(entry.id);
  // A status the lifecycle declares; the roadmap says unavailable or missing for an item it could not read.
  const read = item || (FLOW.states.some((state) => state.id === entry.status) ? { status: entry.status, verdict: null } : null);
  const stage = entry.state === 'landed' ? 'merged' : entry.state === 'accepted' ? 'accepted' : item ? pipelineStage(item) : entry.status;
  // A count reads a row's state, stage, hold and place alone, and draws nothing (#6851).
  if (counting) return { label, position: entry.position, state: read ? (entry.state === 'landed' ? 'verified' : stateOf(read)) : null, held: item ? heldNote(item, source, entry, Date.now()) : null, stage };
  const expanded = view.tab === 'roadmap' && view.roadmapOpen.get(JSON.stringify([view.root, 'i:' + label])) === true;
  // A folded row holds whatever detail is already kept, so it opens in place whole (#1039).
  const detail = item ? detailOf(source, item, expanded, root) : null;
  if (item && !expanded) roadmapAhead.set('i:' + label, () => detailOf(source, item, 'ahead', root));
  /** Build one row's real summary detail only when opened, before its first painted frame. */
  const block = summaryOnly => {
    if (!item) return null;
    const shown = detail?.item || item;
    // Local dates and canonical state/routing observations cross into HTML as values, never callbacks.
    const instants = summaryOnly ? [] : [
      ...source.items.filter(other => (shown.blockedBy || []).includes(other.id) && other.since).map(other => other.since),
      ...(shown.history || []).map(event => event.at), ...(shown.verdicts || []).filter(v => v.at).map(v => v.at),
      ...(shown.verdict?.at ? [shown.verdict.at] : []),
    ];
    return roadmapBlock(shown, {
      times: new Map([...new Set(instants)].map(at => [at, roadmapTime(at)])),
      states: new Map(summaryOnly ? [] : source.items.map(other => [other.id, stateOf(other)])),
      holds: root === view.root ? source.holds : source.laneHolds, itemHolds: source.itemHolds, items: source.items, agents: source.agents,
      address: itemAddress(shown.id, root), board: root === view.root ? null : root,
      releases: renderIndex(p).releases.get(entry.id) || [], summaryOnly,
      error: expanded ? detail?.error : undefined,
    });
  };
  if (item) roadmapDetails.set(JSON.stringify([view.root, 'i:' + label]), () => block(false).detail);
  return {
    label: local ? '#' + entry.id : String(entry.id),
    position: entry.position,
    after: item?.blockedBy || [],
    title: item ? item.title : read ? entry.title : '',
    root,
    titles: renderIndex(source).titles,
    state: read ? (entry.state === 'landed' ? 'verified' : stateOf(read)) : null,
    stageHtml: read ? stageMarkup(item || { ...read, status: entry.state === 'accepted' || entry.state === 'landed' ? 'verified' : read.status,
      merged: entry.state === 'landed' ? 'recorded' : null }, source || {}, item?.status === 'open' && Boolean(item.blockedBy?.length || heldNote(item, source, entry, Date.now())), heldNote(item, source, entry, Date.now()) || '', item ? itemStageMarks(item, source) : [], false, true) : '',
    stale: item ? staleChip(item) : '', held: item ? heldNote(item, source, entry, Date.now()) : null,
    block: block(!expanded && !Array.isArray(detail?.item?.history)),
    // Until its omitted fields arrive, an expanded row paints what its summary holds and fills the rest in place (#1039).
    pending: expanded && Boolean(detail?.loading),
    stage,
    word: entry.status,
    open: item ? { root, id } : null,
    // Why an item does not open, short enough to read beside its id on a phone.
    why: item ? '' : local ? 'not on this board' : root ? 'not on that board' : snapshot ? 'not in this snapshot'
      : named.length > 1 ? 'board name not unique' : named.length ? 'board unreadable' : 'no such board',
  };
}

/** Mark the release nearest the top of the Roadmap in its companion panel. */
function updateRoadmapPanel() {
  const panel = $('roadmap-panel');
  if (!panel || view.tab !== 'roadmap') return;
  aheadRoadmapRows();
  const targets = new Map();
  for (const node of $('roadmap-list').querySelectorAll('[data-key]')) if (!targets.has(node.dataset.key)) targets.set(node.dataset.key, node);
  const entries = [...panel.querySelectorAll('[data-roadmap-jump]')].map((button) => ({
    key: button.dataset.roadmapJump,
    target: targets.get(button.dataset.roadmapJump),
  })).filter((entry) => entry.target);
  if (!entries.length) return;
  const threshold = (document.querySelector('.top')?.getBoundingClientRect().bottom ?? 0) + 8;
  const active = entries.find((entry) => entry.target.getBoundingClientRect().bottom > threshold)?.key || entries.at(-1).key;
  for (const entry of entries) {
    const button = panel.querySelector('[data-roadmap-jump="' + CSS.escape(entry.key) + '"]');
    if (button) {
      if (entry.key === active) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  }
}

/** Open a selected release in the list and briefly mark it after the jump. */
function jumpToRoadmap(key) {
  if (key === 'shipped') {
    view.roadmapOpen.set(JSON.stringify([view.root, 'shipped']), true);
    render();
  } else if (key.startsWith('m:')) {
    // Picking a release opens it and folds every other one to its line, so only the chosen release lists items (#7303).
    for (const button of document.querySelectorAll('#roadmap-panel [data-roadmap-jump^="m:"]')) view.roadmapOpen.set(JSON.stringify([view.root, button.dataset.roadmapJump]), button.dataset.roadmapJump === key);
    view.roadmapPage = { release: key.slice(2), page: view.roadmapPage?.release === key.slice(2) ? view.roadmapPage.page : 1, per: view.roadmapPage?.release === key.slice(2) ? view.roadmapPage.per ?? 25 : 25 };
    address(false);
    render();
  }
  const target = $('roadmap-list')?.querySelector('[data-key="' + CSS.escape(key) + '"]');
  if (!target) return;
  const topbar = document.querySelector('.top');
  if (matchMedia('(max-width: 900px)').matches && topbar) {
    // The Roadmap scrolls in the document viewport; use the wrapped sticky bar's actual lower edge, not its minimum height.
    for (const earlier of document.querySelectorAll('[data-geo="roadmap-target"]')) earlier.removeAttribute('data-geo');
    target.dataset.geo = 'roadmap-target';
    geometry('roadmap-target', { 'scroll-margin-top': Math.ceil(topbar.getBoundingClientRect().bottom + 16) + 'px' });
  } else target.removeAttribute('data-geo');
  target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  markRoadmapArrival(key, target);
  updateRoadmapPanel();
}

/**
 * One item's row on the Roadmap, laid out as the Items list lays one out: the dot of its state, its
 * id and title on one line that ends in an ellipsis when cut, and the Items tab's chip. The whole
 * title is the row's tooltip. Every row expands in place; its compact detail alone links over to Items.
 */
const milestoneRowHtml = (${milestoneRowHtml.toString()});
const readMilestoneModel = (${readMilestoneModel.toString()});
const roadmapRemainingCount = (${roadmapRemainingCount.toString()});
const roadmapCardsHtml = (${roadmapCardsHtml.toString()});
/** Prepare rich title markup and linked prerequisite notes from the current page only. */
function milestonePresentation(row, titles) {
  let afterHtml = '';
  for (const id of (row.after || []).filter(id => id !== null && id !== undefined && String(id).trim() !== '')) afterHtml += '<span class="roadmap-after"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></svg>after <a class="ref" href="' + itemAddress(id, row.root) + '" data-go="item:' + id + '">#' + id + '</a></span>';
  // The after chips share one group that ends in an ellipsis inside the row (#7303).
  if (afterHtml) afterHtml = '<span class="roadmap-afters">' + afterHtml + '</span>';
  return { root: view.root, open: view.roadmapOpen.get(JSON.stringify([view.root, 'i:' + row.label])) === true,
    titleHtml: row.title ? inline(String(row.title).replace(/\\s+/g, ' '), row.titles || titles, 'in-place', row.root) : undefined,
    stateChipHtml: row.stageHtml || (row.state ? chip(row.state) : ''),
    afterHtml };
}
/** Preserve the existing browser helper while delegating its actual HTML to the pure renderer. */
function milestoneRow(row, titles, hidden = false) { return milestoneRowHtml(row, { ...milestonePresentation(row, titles), hidden }); }

/** Read supplied landed counts and explicit shipments; keep old exports readable and omit withdrawn rows. */
function readMilestone(milestone, p, counting = false) {
  return readMilestoneModel(milestone, milestone.items.map(entry => milestoneItem(entry, p, counting)));
}

// Each board state's next release, read once: the navigation and the status bar ask on every click and tab switch,
// and reading every release's items took them 30 to 300 ms (#6851). A change on another board reads it again.
const nextMilestones = new WeakMap();
/** Pick the first release with remaining work in roadmap order; empty plans wait behind it. */
function nextMilestone(p) {
  const kept = nextMilestones.get(p);
  if (kept && kept.projects === data?.projects) return kept.next;
  const found = (p.milestones || []).find((milestone) => {
    const read = readMilestone(milestone, p, true);
    return read.rows.length > 0 && !read.shipped;
  });
  const read = found ? readMilestone(found, p, true) : null;
  const next = found ? { ...found, done: read.done, total: read.total } : found;
  nextMilestones.set(p, { projects: data?.projects, next });
  return next;
}

/** The release focused on, if the person picked one that is still on the board. */
function roadmapFocus(p) {
  return view.roadmapOnly && (p.milestones || []).some(m => m.name === view.roadmapOnly) ? view.roadmapOnly : null;
}

/** One exact set of release reads for both Roadmap HTML and its browser-title count. */
function roadmapReads(p) {
  const only = roadmapFocus(p);
  return (p.milestones || []).filter(m => !only || m.name === only).map(m => readMilestone(m, p));
}

/**
 * The Roadmap (N26, N38) opens releases with work left in board order and folds shipped or finished ones into Shipped.
 * Headers show the backend's summary; accepted and landed rows stay distinct; shipped history carries its commit; old
 * exports keep their legacy completion rule; each part keeps the person's disclosure choice for this visit.
 */
function roadmapCards(p, titles, kept = null) {
  const only = roadmapFocus(p), reads = roadmapReads(p);
  const targetLabels = new Map(), addresses = new Map(), headers = new Map(), headings = new Map(), rows = new Map(), notes = new Map(), targets = new Map();
  const observedAt = Date.parse(p.observedAt), now = Number.isFinite(observedAt) ? observedAt : Date.now();
  const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
  const header = roadmapHeaders({ targetLabels, addresses, headings, root: view.root, held: view.roadmapHeld, now, locale, timeZone });
  for (const read of reads) {
    if (read.milestone.target) { const label = when(read.milestone.target); targetLabels.set(read, label); targets.set(read, label); }
    for (const row of read.rows) {
      if (row.open) addresses.set(row, itemAddress(row.open.id, row.open.root));
      rows.set(row, milestonePresentation(row, titles));
    }
    headings.set(read, linked(read.milestone.name, titles)); // before the header, whose title keeps the name's inline references
    headers.set(read, header(read));
    if (read.milestone.note) notes.set(read, rich(read.milestone.note, titles));
  }
  // With kept, each row's markup is recorded by its key and the card holds an empty slot in its place, so the page can
  // patch only the rows that changed (#6679). A row's key is its release and its item, told apart if one repeats.
  const slots = kept ? { slotKey: (milestone, row) => {
    const base = JSON.stringify([milestone.name, row.label]);
    let key = base;
    for (let n = 2; kept.has(key); n += 1) key = base + n;
    kept.set(key, '');
    return key;
  }, place: (key, html) => { kept.set(key, html); return '<li data-slot="' + esc(key) + '"></li>'; } } : {};
  return { html: roadmapCardsHtml(reads, { only, root: view.root, held: view.roadmapHeld, open: view.roadmapOpen, page: view.roadmapPage, headers, headings, rows, notes, targets, ...slots }) };
}

`;
}
