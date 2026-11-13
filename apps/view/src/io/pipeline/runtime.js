/**
 * Draw the Insights Pipeline page into its pane (#6869). It reads the board's event history through the Dashboard's
 * held history (one read per board, shared), this machine's CPU samples once every ten seconds while the page is open,
 * and nothing else; the model and the markup are pure functions it is handed, and every count it draws is theirs.
 * The page embeds this function's source, so it reads only its arguments.
 */
export function pipelineRuntime({ model, html, history, api, current, redraw, windowMinutes, itemsHref, itemHref, openItems, machineHere }) {
  const MACHINE_EVERY_MS = 10_000;
  const machine = { value: null, at: 0, pending: false, root: null };
  const opened = new Set();
  let touched = false, drawn = { root: null, markup: '' }, wired = null, cache = null;

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
    const held = history(project), minutes = windowMinutes();
    readMachine(project.root);
    const observed = Date.parse(project.observedAt), now = Number.isFinite(observed) ? observed : Date.now();
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
