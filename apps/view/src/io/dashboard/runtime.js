/**
 * Keep complete Dashboard history per board, bounded by each displayed state prefix, using the ordinary read API.
 * `floor`, when given, draws the agent floor in the Dashboard's place at #dashboard/floor from the same model and
 * history, so both pages read one board read and refresh on the same live redraw [N26,N38].
 */
export function dashboardRuntime({ model, html, stagePresentation = null, when = null, api, boardPath, current, redraw, summary, floor = null, firstRun = null, working = null, agentsTable = null, gateTrace = null, eventBatch = 50000 }) {
  const histories = new Map();
  // The Agents table's between-items rows stay open across live redraws once the person opens them (#6847).
  let quietOpen = false;
  // The Agents notch opens #dashboard/agents: the page scrolls to the table once per opening, never on a live redraw.
  let shownAgents = false;
  // The first-run tour keeps its stop across live redraws, so a refresh never sends it back to the start.
  const tour = { index: 0, auto: true, timer: null };
  let drawnFloor = null;
  // The In the gate row whose trace panel is open, and the regions already listening for its clicks (one listener per page region, never one per redraw).
  let openGate = null;
  const listening = new WeakSet();
  let lastNeeds = { root: null, html: '', header: '' };
  /** Whether the events hold every id from 1 to the prefix, by the position of the prefix's last event (ids are strictly rising). */
  function covers(events, prefix) {
    let low = 0, high = events.length;
    while (low < high) { const mid = (low + high) >> 1; if (events[mid].event_id <= prefix) low = mid + 1; else high = mid; }
    return low === prefix && (low === 0 || events[low - 1].event_id === prefix);
  }
  /** The held events up to the prefix: the same array while none lies beyond it, which a live update never does. */
  function upTo(events, prefix) {
    if (!(events.at(-1)?.event_id > prefix)) return events;
    let low = 0, high = events.length;
    while (low < high) { const mid = (low + high) >> 1; if (events[mid].event_id <= prefix) low = mid + 1; else high = mid; }
    return events.slice(0, low);
  }
  /** Read missing history once per prefix; never draw one board's history over another board. */
  function read(root, prefix) {
    const key = root + '|' + boardPath(root);
    let held = histories.get(key);
    if (held && prefix < held.observedPrefix) { histories.delete(key); held = null; }
    if (!held) { held = { events: [], prefix: -1, pending: false, error: null }; histories.set(key, held); }
    if (held.pending || held.prefix >= prefix || held.failedPrefix === prefix && Date.now() - held.failedAt < 5000) return held;
    held.pending = true; held.observedPrefix = prefix;
    const after = held.events.at(-1)?.event_id ?? 0;
    // History reads in pages of eventBatch: one unbounded read of a 600k-event board is past what the API can send.
    const fetched = [];
    const page = from => api(boardPath(root) + '/events?after=' + from + '&limit=' + eventBatch).then(reply => {
      if (!Array.isArray(reply.events)) throw new Error('The board did not return its event history.');
      for (const event of reply.events) fetched.push(event);
      const end = reply.events.at(-1)?.event_id;
      // A full page may have more behind it; a short page, or one that does not move past its cursor, is the end.
      if (reply.events.length >= eventBatch && end > from) return page(end);
    });
    page(after).then(() => {
      const reply = { events: fetched };
      const last = held.events.at(-1)?.event_id ?? 0;
      // New events arrive after the held ones in id order, so they are appended; the folded totals stay valid. Anything else rebuilds the history.
      if (reply.events.every((event, index) => event.event_id > (index ? reply.events[index - 1].event_id : last))) for (const event of reply.events) held.events.push(event);
      else {
        const byId = new Map(held.events.map(event => [event.event_id,event]));
        for (const event of reply.events) byId.set(event.event_id,event);
        held.events = [...byId.values()].sort((a,b)=>a.event_id-b.event_id);
        held.fold = null; held.seen = null;
      }
      held.version = (held.version ?? 0) + 1;
      const covered = prefix === 0 || covers(held.events, prefix);
      held.prefix = covered ? prefix : -1; held.error = covered ? null : 'The available history does not cover this board prefix.';
      if (covered) held.readyOnce = true;
      if (!covered) { held.failedPrefix = prefix; held.failedAt = Date.now(); }
    }).catch(error => { held.error = String(error.message || error); held.failedPrefix = prefix; held.failedAt = Date.now(); }).finally(() => {
      held.pending = false;
      // A failed read waits for the next board refresh, rather than a hot render/retry loop.
      if (current() === root) redraw();
    });
    return held;
  }
  /** What the first-run page reads of the history (the kinds that happened and how many merges), counted once per event up to the prefix. */
  function seen(held, prefix) {
    const tally = held.seen ??= { index: 0, kinds: new Set(), merged: 0 };
    for (; tally.index < held.events.length && held.events[tally.index].event_id <= prefix; tally.index++) {
      const kind = held.events[tally.index].event_kind;
      tally.kinds.add(kind);
      if (kind === 'merged') tally.merged++;
    }
    return tally;
  }
  /** Draw immediately from live claims, then enrich only with the complete ordered prefix when available. */
  /**
   * Draw the Dashboard. With quick, as on a tab switch (#6613), a board that moved since the last model draws from that
   * model at once and returns true: the caller draws again after the frame, when the model is brought up to date.
   */
  function draw(project, needs, { needsHeader = '', quick = false } = {}) {
    if (needs !== undefined) lastNeeds = { root: project.root, html: needs, header: needsHeader };
    else { needs = lastNeeds.root === project.root ? lastNeeds.html : ''; needsHeader = lastNeeds.root === project.root ? lastNeeds.header : ''; }
    const region = document.getElementById('dashboard');
    if (!region) return;
    const prefix = project.sequence ?? Math.max(0, ...(project.events ?? []).map(event => event.event_id));
    let held = histories.get(project.root + '|' + boardPath(project.root));
    if (!held?.error || held.prefix !== prefix) held = read(project.root, prefix);
    const complete = held.prefix >= prefix;
    const observedAt = Date.parse(project.observedAt);
    const now = Number.isFinite(observedAt) ? observedAt : Date.now();
    // Native snapshots are JSON; include every field so changed live data or an observation clock always invalidates.
    const projectKey = JSON.stringify(project), cached = held.modelCache, atWork = working ? working(project) : null, atWorkKey = atWork ? atWork.join('|') : '';
    const fresh = cached && cached.projectKey === projectKey && cached.events === held.events && cached.version === held.version
      && cached.prefix === prefix && cached.complete === complete && cached.now === now && cached.atWorkKey === atWorkKey;
    const behind = !fresh && quick && Boolean(cached?.state);
    const state = fresh || behind ? cached.state : model(project, upTo(held.events, prefix), { complete, now, working: atWork, fold: held.fold ??= {} });
    if (!behind) held.modelCache = { projectKey, events: held.events, version: held.version, prefix, complete, now, atWorkKey, state };
    const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
    const progress = state.milestone ? summary(state.milestone, { now, locale, timeZone })?.header ?? '' : '';
    // Native details keep each Show-more/quiet disclosure open across live refreshes.
    const expanded = [...region.querySelectorAll('details[open]')].map(entry=>entry.dataset.dashboardDisclosure);
    const onFloor = Boolean(floor?.open());
    // Browser preferences enter through this DOM adapter; pure renderers never discover host defaults.
    const note = held.error?'<p class="muted" role="status">Dashboard history is unavailable; live work remains visible.</p>':'';
    let quietRows;
    // Until the person hides it (finished or not), the first-run page is the Dashboard; the usual cards follow once work has landed.
    const started = firstRun && !onFloor ? firstRun.kit.model(project, seen(held, prefix)) : null;
    const showFirstRun = firstRun?.kit.visible(started, firstRun.hidden(project.root));
    const usual = () => html(state, { needs, needsHeader, progress, locale, timeZone, stagePresentation, when, deferQuiet: quietOpen ? undefined : rows => { quietRows = rows; }, floorHref: floor?.href('floor'), gate: gateTrace ? { open: openGate, trace: gateTrace } : null });
    // A click on a gate row opens its trace panel, a second click (or Close) shuts it; the redraw paints the panel from the held model at once.
    if (gateTrace && !listening.has(region) && region.addEventListener) {
      listening.add(region);
      region.addEventListener('click', event => {
        const row = event.target?.closest?.('[data-gate-trace]');
        if (!row) return;
        const id = Number(row.dataset?.gateTrace ?? row.getAttribute?.('data-gate-trace'));
        openGate = openGate === id ? null : id;
        redraw();
      });
    }
    region.innerHTML = (onFloor ? floor.html(floor.model(state, held.events.filter(event=>event.event_id<=prefix)), { back: floor.href(null), locale, timeZone })
      : showFirstRun ? firstRun.kit.html(started, { href: firstRun.href, tour: tour.index }) + (started.landed ? usual() : '') : usual())+note;
    if (showFirstRun) startTour();
    region.classList?.toggle('floor-page', onFloor);
    // Opening or leaving the floor starts at its top; a live redraw of the same page keeps the reader's place.
    if (drawnFloor !== null && drawnFloor !== onFloor) globalThis.scrollTo?.(0, 0);
    drawnFloor = onFloor;
    const quiet = region.querySelector?.('[data-dashboard-quiet]'), quietBody = region.querySelector?.('[data-dashboard-quiet-rows]');
    /** Show or hide the between-items rows, filling them from the current model the first time they open. */
    function showQuiet(open) {
      // A detached prior render cannot fill its old root or model into the current page.
      if (!quiet?.isConnected || current() !== project.root || !region.contains(quiet)) return;
      if (open && quietRows) { quietBody.innerHTML = quietRows(); quietRows = null; }
      quietBody.hidden = !open;
      quiet.setAttribute('aria-expanded', String(open));
      quiet.firstChild.textContent = open ? '▾ ' : '▸ ';
    }
    if (quiet && quietBody) {
      quiet.addEventListener('click', () => { quietOpen = quietBody.hidden; showQuiet(quietOpen); });
      if (quietOpen) showQuiet(true);
    }
    const wantsAgents = Boolean(agentsTable?.()) && !onFloor;
    // After the frame, so the page's own scroll restoring for an address never lands after it.
    if (wantsAgents && !shownAgents) (globalThis.requestAnimationFrame ?? (step => step()))(() => region.querySelector?.('#dashboard-agents')?.scrollIntoView?.({ block: 'start' }));
    shownAgents = wantsAgents;
    for (const disclosure of region.querySelectorAll('details')) if (expanded.includes(disclosure.dataset.dashboardDisclosure)) disclosure.open = true;
    return behind;
  }
  /** Advance the tour on its own, one stop per reading time, until the person steps it by hand or the page is left. */
  function startTour() {
    if (tour.timer || !firstRun || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const wait = () => { tour.timer = setTimeout(() => {
      const region = document.getElementById('dashboard');
      if (!region?.querySelector('[data-first-run-tour]')) { tour.timer = null; return; }
      if (tour.auto) { tour.index = (tour.index + 1) % firstRun.kit.steps.length; firstRun.kit.paint(region, tour.index); }
      wait();
    }, firstRun.kit.dwell(tour.index)); };
    wait();
  }
  /** The arrows step the tour by hand, which stops it advancing itself. */
  function tourStep(by) {
    const stops = firstRun.kit.steps.length;
    tour.auto = false;
    tour.index = (tour.index + by + stops) % stops;
    firstRun.kit.paint(document.getElementById('dashboard'), tour.index);
  }
  /** Read the board's missing history ahead of a switch to the Dashboard, drawing nothing (#6613). */
  function warm(project) {
    const prefix = project.sequence ?? Math.max(0, ...(project.events ?? []).map(event => event.event_id));
    read(project.root, prefix);
  }
  /**
   * The board's held event history up to the state's prefix, for the pages that read it beside the Dashboard (Pipeline, #6869):
   * the same one read per board, started here if nothing has. `complete` is false until every event up to the prefix is on hand; `usable` says the history was complete once, so on a board that moves every second it is
   * at most a few events behind and still fine to count from.
   */
  function historyOf(project) {
    const prefix = project.sequence ?? Math.max(0, ...(project.events ?? []).map(event => event.event_id));
    let held = histories.get(project.root + '|' + boardPath(project.root));
    if (!held?.error || held.prefix !== prefix) held = read(project.root, prefix);
    return { events: upTo(held.events, prefix), complete: held.prefix >= prefix, usable: held.readyOnce === true, version: held.version ?? 0, error: held.error };
  }
  /** The model and history the last draw of this board held, or null before the Dashboard has drawn it; reads nothing from the board. */
  function held(root) {
    const kept = histories.get(root + '|' + boardPath(root));
    return kept?.modelCache ? { state: kept.modelCache.state, events: kept.events.filter(event => event.event_id <= kept.modelCache.prefix) } : null;
  }
  return { draw, tourStep, warm, history: historyOf, held };
}
