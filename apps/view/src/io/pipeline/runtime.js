/**
 * Draw the Insights Pipeline page into its pane (#6869). It reads only the board's events inside the model's 26-hour floor
 * (never the whole history the Dashboard keeps), this machine's CPU samples once every ten seconds while the page is open,
 * and nothing else; the model and the markup are pure functions it is handed, and every count it draws is theirs.
 * The page embeds this function's source, so it reads only its arguments.
 */
export function pipelineRuntime({ model, html, api, boardPath, current, redraw, windowMinutes, itemsHref, itemHref, openItems, machineHere }) {
  const MACHINE_EVERY_MS = 10_000;
  // The model counts the last min(two windows, 26 hours) of events, which for every window the page offers is 26 hours.
  const FLOOR_MS = 26 * 3_600_000, BATCH = 50_000, RETRY_MS = 5000;
  const windows = new Map();
  const machine = { value: null, at: 0, pending: false, root: null };
  const opened = new Set();
  let touched = false, drawn = { root: null, markup: '' }, wired = null, cache = null;

  /**
   * Read the events inside the floor once per prefix: find the first id inside it by probing one event at a time (event ids
   * rise with event_at), then page from there with a limit; a later read appends only what follows the last held id.
   */
  function read(project, now) {
    const root = project.root, prefix = project.sequence ?? 0, key = root + '|' + boardPath(root);
    let held = windows.get(key);
    if (held && prefix < held.observedPrefix) { windows.delete(key); held = null; }
    if (!held) { held = { events: [], start: null, prefix: -1, observedPrefix: -1, pending: false, error: null, version: 0, readyOnce: false }; windows.set(key, held); }
    if (held.pending || held.prefix >= prefix || held.failedPrefix === prefix && Date.now() - held.failedAt < RETRY_MS) return held;
    held.pending = true; held.observedPrefix = prefix;
    const events = after => api(boardPath(root) + '/events?after=' + after + '&limit=' + BATCH).then(reply => {
      if (!Array.isArray(reply.events)) throw new Error('The board did not return its event history.');
      return reply.events;
    });
    const cutoff = now - FLOOR_MS;
    /** Whether the first event after this id is inside the floor, or there is none. */
    const inside = after => api(boardPath(root) + '/events?after=' + after + '&limit=1').then(reply => {
      if (!Array.isArray(reply.events)) throw new Error('The board did not return its event history.');
      const at = Date.parse(reply.events[0]?.event_at);
      return !reply.events.length || !(at < cutoff);
    });
    /** The id after which every event is inside the floor: the smallest id whose next event is. */
    const find = async () => {
      let low = 0, high = prefix;
      while (high - low > 1) { const mid = (low + high) >> 1; if (await inside(mid)) high = mid; else low = mid; }
      // Only a board that lies wholly inside the floor ends at its first event, and then the window does start at the beginning.
      return high <= 1 ? 0 : high;
    };
    const fetched = [];
    const page = from => events(from).then(list => {
      for (const event of list) fetched.push(event);
      const end = list.at(-1)?.event_id;
      if (list.length >= BATCH && end > from) return page(end);
    });
    (held.start === null ? find().then(start => { held.start = start; }) : Promise.resolve())
      .then(() => page(held.events.at(-1)?.event_id ?? held.start))
      .then(() => {
        const last = held.events.at(-1)?.event_id ?? 0;
        for (const event of fetched) if (event.event_id > last) held.events.push(event);
        held.version++; held.prefix = prefix; held.error = null; held.readyOnce = true;
      }).catch(error => { held.error = String(error.message || error); held.failedPrefix = prefix; held.failedAt = Date.now(); })
      .finally(() => { held.pending = false; if (current() === root) redraw(); });
    return held;
  }

  /** Read this machine's samples when the last read is old; the page draws again when they arrive. */
  function readMachine(root) {
    if (!machineHere || machine.pending || (machine.root === root && Date.now() - machine.at < MACHINE_EVERY_MS)) return;
    machine.pending = true;
    api('/api/v1/machine').then(reply => { machine.value = reply?.machine ?? null; }).catch(() => { machine.value = null; })
      .finally(() => { machine.pending = false; machine.at = Date.now(); machine.root = root; if (current() === root) redraw(); });
  }

  /** One handler for the pane: a group opens and closes in place, a count opens Items on the items it counted. */
  function wire(region) {
    if (wired === region) return;
    wired = region;
    region.addEventListener('click', event => {
      const counted = event.target.closest?.('a[data-pipeline-ids]');
      if (counted && region.contains(counted)) {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button > 0) return;
        event.preventDefault();
        openItems(counted.dataset.pipelineIds.split(',').map(Number).filter(Number.isInteger));
        return;
      }
      const head = event.target.closest?.('.pw-gh');
      if (head && !event.target.closest('a')) toggle(head);
    });
    region.addEventListener('keydown', event => {
      const head = event.target.closest?.('.pw-gh');
      if (head && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(head); }
    });
  }
  function toggle(head) {
    const group = head.parentElement, key = group.dataset.pipelineGroup;
    const open = !group.classList.contains('open');
    // The first press fixes the open groups as the person has them: from then on the page keeps exactly these.
    if (!touched) { touched = true; for (const entry of group.parentElement.querySelectorAll('.pw-gr.open')) opened.add(entry.dataset.pipelineGroup); }
    group.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    if (open) opened.add(key); else opened.delete(key);
  }

  /** Draw the page for the board's current state. */
  function draw(project) {
    const region = document.getElementById('insights-pipeline');
    if (!region) return;
    wire(region);
    const minutes = windowMinutes();
    readMachine(project.root);
    const observed = Date.parse(project.observedAt), now = Number.isFinite(observed) ? observed : Date.now();
    const prefix = project.sequence ?? 0, kept = read(project, now);
    // Events beyond the state's prefix are not counted; a live update never leaves any, so this is the same array.
    const held = { events: kept.events.at(-1)?.event_id > prefix ? kept.events.filter(event => event.event_id <= prefix) : kept.events, complete: kept.prefix >= prefix, usable: kept.readyOnce, version: kept.version, error: kept.error };
    const ready = held.complete || held.usable === true;
    const key = [project.root, project.sequence, now, held.version, held.events.length, ready, minutes, machine.at].join('|');
    let markup;
    if (!ready) {
      markup = '<div class="dash-live pw-page"><p class="dash-empty pw-none" role="status">' + (held.error ? 'The board’s event history is unavailable, so this page has nothing to count.' : 'Reading the board’s event history…') + '</p></div>';
    } else if (cache?.key === key) markup = cache.markup;
    else {
      const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
      const state = model(project, held.events, { now, windowMinutes: minutes, complete: true, machine: machine.value });
      markup = html(state, { href: itemsHref, itemHref, locale, timeZone, machineHere, open: touched ? [...opened] : null });
      cache = { key, markup };
    }
    if (drawn.root === project.root && drawn.markup === markup) return;
    drawn = { root: project.root, markup };
    region.innerHTML = markup;
  }
  return { draw };
}
