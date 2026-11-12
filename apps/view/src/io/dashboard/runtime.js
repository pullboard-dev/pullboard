/**
 * Keep complete Dashboard history per board, bounded by each displayed state prefix, using the ordinary read API.
 * `floor`, when given, draws the agent floor in the Dashboard's place at #dashboard/floor from the same model and
 * history, so both pages read one board read and refresh on the same live redraw [N26,N38].
 */
export function dashboardRuntime({ model, html, stagePresentation = null, when = null, api, boardPath, current, redraw, summary, floor = null, firstRun = null }) {
  const histories = new Map();
  // The first-run tour keeps its stop across live redraws, so a refresh never sends it back to the start.
  const tour = { index: 0, auto: true, timer: null };
  let drawnFloor = null;
  let lastNeeds = { root: null, html: '', header: '' };
  /** Read missing history once per prefix; never draw one board's history over another board. */
  function read(root, prefix) {
    const key = root + '|' + boardPath(root);
    let held = histories.get(key);
    if (held && prefix < held.observedPrefix) { histories.delete(key); held = null; }
    if (!held) { held = { events: [], prefix: -1, pending: false, error: null }; histories.set(key, held); }
    if (held.pending || held.prefix >= prefix || held.failedPrefix === prefix && Date.now() - held.failedAt < 5000) return held;
    held.pending = true; held.observedPrefix = prefix;
    const after = held.events.at(-1)?.event_id ?? 0;
    api(boardPath(root) + '/events?after=' + after).then(reply => {
      if (!Array.isArray(reply.events)) throw new Error('The board did not return its event history.');
      const byId = new Map(held.events.map(event => [event.event_id,event]));
      for (const event of reply.events) byId.set(event.event_id,event);
      held.events = [...byId.values()].sort((a,b)=>a.event_id-b.event_id);
      const selected = held.events.filter(event => event.event_id <= prefix);
      const covered = prefix === 0 || selected.length === prefix && selected.every((event,index) => event.event_id === index + 1);
      held.prefix = covered ? prefix : -1; held.error = covered ? null : 'The available history does not cover this board prefix.';
      if (!covered) { held.failedPrefix = prefix; held.failedAt = Date.now(); }
    }).catch(error => { held.error = String(error.message || error); held.failedPrefix = prefix; held.failedAt = Date.now(); }).finally(() => {
      held.pending = false;
      // A failed read waits for the next board refresh, rather than a hot render/retry loop.
      if (current() === root) redraw();
    });
    return held;
  }
  /** Draw immediately from live claims, then enrich only with the complete ordered prefix when available. */
  function draw(project, needs, { rules = '', capacity = '', needsHeader = '' } = {}) {
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
    const projectKey = JSON.stringify(project), cached = held.modelCache;
    const state = cached && cached.projectKey === projectKey && cached.events === held.events
      && cached.prefix === prefix && cached.complete === complete && cached.now === now ? cached.state
      : model(project, held.events.filter(event=>event.event_id<=prefix), { complete, now });
    held.modelCache = { projectKey, events: held.events, prefix, complete, now, state };
    const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
    const progress = state.milestone ? summary(state.milestone, { now, locale, timeZone })?.header ?? '' : '';
    // Native details keep each Show-more/quiet disclosure open across live refreshes.
    const expanded = [...region.querySelectorAll('details[open]')].map(entry=>entry.dataset.dashboardDisclosure);
    const onFloor = Boolean(floor?.open());
    // Browser preferences enter through this DOM adapter; pure renderers never discover host defaults.
    const note = held.error?'<p class="muted" role="status">Dashboard history is unavailable; live work remains visible.</p>':'';
    let quietRows;
    const quietOpen = expanded.includes('quiet');
    // Until the person hides it (finished or not), the first-run page is the Dashboard; the usual cards follow once work has landed.
    const started = firstRun && !onFloor ? firstRun.kit.model(project, held.events.filter(event=>event.event_id<=prefix)) : null;
    const showFirstRun = firstRun?.kit.visible(started, firstRun.hidden(project.root));
    const usual = () => html(state, { needs, needsHeader, progress, rules, capacity, locale, timeZone, stagePresentation, when, deferQuiet: quietOpen ? undefined : rows => { quietRows = rows; }, floorHref: floor?.href('floor') });
    region.innerHTML = (onFloor ? floor.html(floor.model(state, held.events.filter(event=>event.event_id<=prefix)), { back: floor.href(null), locale, timeZone })
      : showFirstRun ? firstRun.kit.html(started, { href: firstRun.href, tour: tour.index }) + (started.landed ? usual() : '') : usual())+note;
    if (showFirstRun) startTour();
    region.classList?.toggle('floor-page', onFloor);
    // Opening or leaving the floor starts at its top; a live redraw of the same page keeps the reader's place.
    if (drawnFloor !== null && drawnFloor !== onFloor) globalThis.scrollTo?.(0, 0);
    drawnFloor = onFloor;
    const quiet = [...region.querySelectorAll('[data-dashboard-disclosure="quiet"]')][0];
    /** Fill current quiet rows before native summary activation exposes them. */
    function materializeQuiet() {
      // A detached prior render cannot materialize its old root or model into the current page.
      if (!quiet?.isConnected || current() !== project.root || !region.contains(quiet)) return;
      const target = quiet.querySelector('[data-dashboard-quiet-rows]');
      if (quietRows && target) { target.innerHTML = quietRows(); quietRows = null; }
    }
    if (quiet && quietRows) {
      quiet.querySelector('summary').addEventListener('click', materializeQuiet);
      quiet.addEventListener('toggle', () => { if (quiet.open) materializeQuiet(); });
    }
    for (const disclosure of region.querySelectorAll('details')) if (expanded.includes(disclosure.dataset.dashboardDisclosure)) disclosure.open = true;
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
  return { draw, tourStep, warm };
}
