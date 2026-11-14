/**
 * The Activity page's browser half (#6916): reads the board's last hours of events once and then only what is new, builds
 * the flow model from them and the live snapshot, draws the page, and carries its clicks, hover card, Esc and resize.
 * The page's state (the open hour, tab and item, the pagers) is `ui`, owned here and changed only by `step`; the filter,
 * person and window live in the address, so they come from, and go back to, the page through the callbacks.
 * The page embeds this function's source text, so it reads only its arguments and language globals [N26].
 *
 * @param {object} deps
 * @param {Function} deps.flow - activityFlow.
 * @param {Function} deps.html - activityPageHtml.
 * @param {Function} deps.tip - activityTipHtml.
 * @param {Function} deps.step - activityStep.
 * @param {Function} deps.start - activityStart.
 * @param {Function} deps.api - The page's read API.
 * @param {Function} deps.boardPath - A board's API path.
 * @param {Function} deps.current - The board the page shows.
 * @param {Function} deps.view - Returns the page's view state: activityFilter, activityBy and activityWin come from the address; activityPeople and activityCounts go back for the strip.
 * @param {Function} deps.project - The snapshot the page holds now.
 * @param {Function} deps.active - Whether the Activity page is the one showing.
 * @param {Function} [deps.itemHref] - The address of an item, so a cited #N in a quote links to it.
 * @param {Function} deps.working - The seats at work for a project.
 * @param {Function} deps.controls - The filter strip's markup, for a narrow screen.
 * @param {Function} deps.onFilter - Put a filter in the address (and the strip): onFilter(value).
 * @param {Function} deps.after - Called when the page's own state changed what the strip shows.
 * @param {Function} deps.remember - remember(root) reads the last look; remember(root, ms) keeps one.
 * @param {Function} [deps.drawn] - Called after the page's markup is replaced, so a line the page appended to it (the older-history note) is drawn again.
 * @returns {{ draw: Function, reset: Function }}
 */
export function activityRuntime({ flow, html, tip, step, start, api, boardPath, current, view, project: held_project, active, working, itemHref, controls, onFilter, after, remember, drawn }) {
  const boards = new Map();
  const HOUR = 3_600_000, PAD = 3 * HOUR;
  let node = null, tipNode = null, watcher = null, resizing = null, wired = false;
  const held = root => { if (!boards.has(root)) boards.set(root, { events: [], last: 0, hours: 0, pending: false, version: 0, error: null, ui: null, model: null, key: '', painted: '', baseline: null, left: remember(root) ?? null }); return boards.get(root); };

  /** Read the events since the window opened, once: the first id at or after the cut is found by halving, then everything after it streams in. */
  async function read(project, state, hours) {
    const root = project.root, prefix = project.sequence ?? 0, now = Date.parse(project.observedAt) || Date.now();
    if (state.pending || (state.hours >= hours && state.last >= prefix)) return;
    state.pending = true;
    try {
      let after = state.last;
      if (state.hours < hours) {
        const cut = now - hours * HOUR - PAD;
        let low = 0, high = prefix;
        while (low < high) {
          const mid = (low + high) >> 1;
          const reply = await api(boardPath(root) + '/events?after=' + mid + '&limit=1');
          const event = reply.events?.[0];
          if (!event || Date.parse(event.event_at) >= cut) high = mid; else low = mid + 1;
        }
        state.events = []; after = Math.max(0, low - 1); state.hours = hours;
      }
      const reply = await api(boardPath(root) + '/events?after=' + after);
      if (!Array.isArray(reply.events)) throw new Error('The board did not return its events.');
      const known = new Set(state.events.slice(-2000).map(event => event.event_id));
      for (const event of reply.events) if (!known.has(event.event_id)) state.events.push(event);
      state.last = state.events.at(-1)?.event_id ?? state.last;
      state.error = null; state.version++;
      state.baseline ??= state.last;
    } catch (error) { state.error = String(error.message || error); state.hours = 0; state.failedAt = Date.now(); } finally {
      state.pending = false;
      const latest = held_project(); if (current() === root && latest) { paint(latest, true); after(); }
    }
  }

  /** The hour cards' inner width: the feed column's, which the stylesheet sets from the width of the page. */
  function widths() {
    const whole = node.clientWidth || 740;
    const feed = whole > 1000 ? Math.min(780, whole - 316) : whole;
    return { width: Math.max(260, Math.floor(feed) - 2), narrow: whole <= 640 };
  }

  /** Draw from the held events and the live snapshot; repaint only when the markup changed. */
  function paint(project, force = false) {
    if (!node || current() !== project.root) return;
    const V = view(), state = held(project.root), hours = V.activityWin || 24, by = V.activityBy || null;
    if (!state.pending && state.error === null && (state.hours < hours || state.last < (project.sequence ?? 0))) void read(project, state, hours);
    else if (state.error !== null && Date.now() - (state.failedAt ?? 0) > 5000 && !state.pending) void read(project, state, hours);
    const now = Date.parse(project.observedAt) || Date.now();
    const known = state.left !== null, left = known ? state.left : now - HOUR;
    const atWork = working(project), key = [project.root, project.sequence, project.observedAt, state.version, hours, by ?? '', left, (atWork ?? []).length, project.counts?.agents ?? '', project.counts?.runners ?? (project.dashboardRunners?.runners ?? []).length].join('|');
    if (!state.model || state.key !== key) { state.model = flow(project, state.events, { now, windowHours: hours, left, working: atWork, by }); state.key = key; }
    const model = state.model;
    state.shown = quiet(project, state);
    // The page opens its starting hour once the board's events are in, so it never settles on an hour the events have not reached.
    if (!state.ui && state.version > 0) state.ui = start(model);
    const ui = state.ui ?? start(model);
    if (state.ui && state.ui.open !== null && !model.hours.some(hour => hour.h0 === state.ui.open) && state.ui.item === null) state.ui = { ...state.ui, open: model.hours[0]?.h0 ?? null };
    if (state.ui && (state.ui.filter ?? 'all') !== (V.activityFilter || 'all')) state.ui = step(state.ui, { type: 'filter', filter: V.activityFilter || 'all' }, model);
    V.activityPeople = model.people; V.activityCounts = model.counts;
    const { width, narrow } = widths();
    const newer = state.baseline === null ? 0 : model.events.filter(entry => entry.event > state.baseline).length;
    const markup = (state.pending && !state.events.length ? '<p class="act-since">Reading the board’s last ' + hours + ' hours…</p>' : '')
      + (state.error ? '<p class="act-since">The board’s events could not be read: ' + String(state.error).replace(/[<>&]/g, '') + '</p>' : '')
      + html(model, state.ui ?? ui, { width, narrow, leftKnown: known, newer, controls: controls(), itemHref });
    if (force || markup !== state.painted || node.dataset.boardRoot !== project.root) {
      node.dataset.boardRoot = project.root;
      node.innerHTML = markup; state.painted = markup;
      drawn?.();
    }
  }

  /** Move the page's state by one step and draw it again. */
  function go(action) {
    const project = held_project(); if (!project) return;
    const state = held(project.root);
    if (!state.ui) return;
    state.ui = step(state.ui, action, state.model);
    if (action.type === 'filter' || action.type === 'lane') after();
    paint(project, true);
  }

  function wire() {
    if (wired) return; wired = true;
    node.addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const project = held_project(); if (!project) return;
      const state = held(project.root), card = target.closest('[data-hour]');
      const hour = card ? Number(card.dataset.hour) : null;
      let found;
      if (target.closest('[data-act-close]')) go({ type: 'close' });
      else if ((found = target.closest('[data-act-tab]'))) { if (found.dataset.actTab === 'item') go({ type: 'tab', tab: 'item' }); else go({ type: 'hour', hour: Number(found.dataset.hour) }); }
      else if ((found = target.closest('g[data-id], [data-row]')) && !target.closest('.act-ipe')) go({ type: 'item', item: Number(found.dataset.id ?? found.dataset.row), hour });
      else if ((found = target.closest('[data-act-lane]'))) { if ((view().activityFilter || 'all') !== 'all') onFilter('all'); go({ type: 'lane', stage: found.dataset.actLane, sub: found.dataset.sub }); }
      else if ((found = target.closest('[data-act-go]'))) { onFilter(found.dataset.actGo); go({ type: 'filter', filter: found.dataset.actGo }); }
      else if ((found = target.closest('[data-act-page]'))) { go({ type: 'page', by: Number(found.dataset.actPage) }); node.querySelector('#act-hours')?.scrollIntoView?.({ block: 'start' }); }
      else if ((found = target.closest('[data-act-pg]'))) go({ type: 'pager', hour: Number(found.dataset.actPg), to: Number(found.dataset.to) });
      else if ((found = target.closest('[data-act-res]'))) go({ type: 'cell', cell: Number(found.dataset.actRes) });
      else if (target.closest('[data-act-new]')) { state.baseline = state.last; paint(project, true); globalThis.scrollTo?.({ top: 0 }); }
      else if ((found = target.closest('[data-act-hour]'))) go({ type: 'hour', hour: Number(found.dataset.actHour) });
    });
    let hovered = null;
    node.addEventListener('mousemove', event => {
      const target = event.target; if (!(target instanceof Element)) return;
      const row = target.closest('[data-row]'), id = row ? Number(row.dataset.row) : null;
      if (id !== hovered) {
        hovered = id;
        const hours = node.querySelector('#act-hours');
        hours?.classList.toggle('hovering', id !== null);
        for (const lit of node.querySelectorAll('g.hot')) lit.classList.remove('hot');
        if (id !== null) for (const lit of node.querySelectorAll('g[data-id="' + id + '"]')) lit.classList.add('hot');
      }
      const bar = target.closest('g[data-id]'), project = held_project(), model = project ? held(project.root).model : null;
      const item = bar && model ? model.journeyById.get(Number(bar.dataset.id)) : null;
      if (!item || !tipNode) { if (tipNode) tipNode.hidden = true; return; }
      tipNode.innerHTML = tip(item, model); tipNode.hidden = false;
      const box = tipNode.getBoundingClientRect();
      let x = event.clientX + 16, y = event.clientY + 12;
      if (x + box.width > innerWidth - 8) x = event.clientX - box.width - 16;
      if (y + box.height > innerHeight - 8) y = Math.max(8, innerHeight - box.height - 8);
      tipNode.getAnimations().forEach(running => running.cancel());
      tipNode.animate({ transform: 'translate(' + Math.max(8, x) + 'px, ' + y + 'px)' }, { duration: 0, fill: 'forwards' });
    });
    node.addEventListener('mouseleave', () => { if (tipNode) tipNode.hidden = true; });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !node?.isConnected || !active()) return;
      const project = held_project(); if (!project) return;
      if (held(project.root).ui?.item !== null && held(project.root).ui?.item !== undefined) go({ type: 'close' });
    });
    const keepLook = () => { const root = current(); if (root) remember(root, Date.now()); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') keepLook(); });
    if (typeof addEventListener === 'function') addEventListener('pagehide', keepLook);
    if (typeof ResizeObserver === 'function') {
      watcher = new ResizeObserver(() => { clearTimeout(resizing); resizing = setTimeout(() => { const project = held_project(); if (project && node.isConnected && active()) paint(project, true); }, 80); });
      watcher.observe(node);
    }
  }

  /** What the drawn page was read from, apart from the snapshot's clock: the board, its events and the page's choices. */
  function quiet(project, state) {
    const V = view();
    return [project.root, project.sequence, state.version, state.hours, V.activityWin || 24, V.activityBy ?? '', V.activityFilter || 'all', state.left, (working(project) ?? []).length].join('|');
  }

  /** Draw the page for this snapshot; the first call wires the page's own handlers.
   * A tab switch back to a page drawn from this same board shows it as it was, so its bars do not grow with the clock [#6613].
   */
  function draw(project, switching = false) {
    node = document.getElementById('activity'); tipNode = document.getElementById('act-tip');
    if (!node) return;
    wire();
    const state = held(project.root);
    if (switching && state.painted && node.dataset.boardRoot === project.root && state.shown === quiet(project, state)) return;
    paint(project);
  }

  /** Forget a board's held events, so the next draw reads them again. */
  function reset(root) { boards.delete(root); }
  return { draw, reset };
}
